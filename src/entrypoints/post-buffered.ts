/**
 * Post-step: drains the inline-comment buffer left by the MCP server during
 * the pi run, and posts each surviving entry as a real PR review comment.
 *
 * Pure orchestration logic lives in `postBuffered(deps)`; the file's bottom
 * runs it against real fs/octokit when invoked as a CLI.
 */
import { buildReviewCommentParams } from "../mcp/handlers";

/**
 * The narrow Octokit slice the post-step actually uses. Defined explicitly
 * (not `Pick<OctokitLike, …>` derived) so callers don't need an
 * `as unknown as` cast — both `@actions/github` and `@octokit/rest`
 * Octokits have method signatures permissive enough to satisfy this.
 */
export interface PostBufferedOctokit {
  pulls: {
    createReviewComment(params: Record<string, unknown>): Promise<{
      data: { id: number };
    }>;
    get(params: Record<string, unknown>): Promise<{
      data: { head: { sha: string } };
    }>;
  };
}

export interface PostBufferedDeps {
  /** Returns the full buffer file contents (or "" if missing). */
  readBuffer: () => string;
  octokit: PostBufferedOctokit;
  env: { repoOwner: string; repoName: string; prNumber: string };
  log?: (msg: string) => void;
}

export interface PostSummary {
  posted: number;
  skipped: number;
  failed: number;
}

interface BufferedEntry {
  ts?: string;
  path: string;
  body: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  commit_id?: string;
  /** confirmed===false means user explicitly opted out → never post. */
  confirmed?: boolean;
}

export async function postBuffered(deps: PostBufferedDeps): Promise<PostSummary> {
  const raw = deps.readBuffer();
  if (!raw.trim()) return { posted: 0, skipped: 0, failed: 0 };

  const entries: BufferedEntry[] = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BufferedEntry);

  const summary: PostSummary = { posted: 0, skipped: 0, failed: 0 };
  const log = deps.log ?? (() => {});

  // We need the PR head SHA when an entry didn't store its own commit_id.
  // Fetch once, lazily — and cache failures too: if pulls.get fails on the
  // first call (bad token, rate limit), retrying for every subsequent
  // entry just amplifies the API spam.
  let headShaResolved: string | null | undefined; // undefined=not yet, null=failed
  const ensureHeadSha = async (): Promise<string> => {
    if (typeof headShaResolved === "string") return headShaResolved;
    if (headShaResolved === null) throw new Error("PR head SHA unavailable (prior fetch failed)");
    try {
      const pr = await deps.octokit.pulls.get({
        owner: deps.env.repoOwner,
        repo: deps.env.repoName,
        pull_number: parseInt(deps.env.prNumber, 10),
      });
      headShaResolved = pr.data.head.sha;
      return headShaResolved;
    } catch (err) {
      headShaResolved = null;
      throw err;
    }
  };

  for (const entry of entries) {
    if (entry.confirmed === false) {
      summary.skipped++;
      log(`skipped (confirmed=false) ${entry.path}:${entry.line}`);
      continue;
    }
    const params = buildReviewCommentParams(
      entry,
      deps.env,
      entry.commit_id ?? (await ensureHeadSha()),
    );

    try {
      await deps.octokit.pulls.createReviewComment(params);
      summary.posted++;
      log(`posted ${entry.path}:${entry.line}`);
    } catch (err) {
      summary.failed++;
      log(
        `failed ${entry.path}:${entry.line} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return summary;
}
