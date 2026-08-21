/**
 * Post-step: drains the inline-comment buffer left by the MCP server during
 * the pi run, and posts each surviving entry as a real PR review comment.
 *
 * Pure orchestration logic lives in `postBuffered(deps)`; the file's bottom
 * runs it against real fs/octokit when invoked as a CLI.
 */
import { buildReviewCommentParams } from "../mcp/handlers";
import {
  appendFindingMarker,
  extractFindingIds,
  stableInlineFindingId,
} from "../review/finding-markers";
import { withGitHubRetry } from "../github/retry";
import {
  commentableLinesForPatch,
  type CommentableLines,
} from "../review/diff-context";

export { commentableLinesForPatch } from "../review/diff-context";

/**
 * Narrow Octokit slice the post-step uses. `any` for params + responses to
 * accept either @actions/github (.rest) or @octokit/rest (.) variants;
 * Octokit's full generic types don't structurally fit a hand-rolled subset.
 */
export type PostBufferedOctokit = {
  pulls: {
    createReviewComment: (params: any) => Promise<any>;
    createReview?: (params: any) => Promise<any>;
    get: (params: any) => Promise<any>;
    listFiles?: (params: any) => Promise<any>;
    listReviewComments?: (params: any) => Promise<any>;
  };
};

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
  duplicate?: number;
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

function isEntryCommentable(entry: BufferedEntry, map: Map<string, CommentableLines>): string | null {
  const lines = map.get(entry.path);
  if (!lines) return "file is not in the PR diff";
  if (lines.RIGHT.size === 0 && lines.LEFT.size === 0) {
    return "file has no textual diff";
  }

  const side = entry.side ?? "RIGHT";
  const anchors = lines[side];
  const line = entry.line;
  if (line === undefined) return "line is missing";
  if (!anchors.has(line)) return `line ${line} (${side}) is not inside a diff hunk`;
  if (entry.startLine !== undefined) {
    if (entry.startLine > line) return `startLine ${entry.startLine} is after line ${line}`;
    if (!anchors.has(entry.startLine)) {
      return `startLine ${entry.startLine} (${side}) is not inside a diff hunk`;
    }
  }
  return null;
}

function toCreateReviewComment(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const {
    owner: _owner,
    repo: _repo,
    pull_number: _pullNumber,
    commit_id: _commitId,
    ...comment
  } = params;
  return comment;
}

async function buildCommentableMap(
  octokit: PostBufferedOctokit,
  env: PostBufferedDeps["env"],
): Promise<Map<string, CommentableLines> | null> {
  const listFiles = octokit.pulls.listFiles;
  if (!listFiles) return null;

  const map = new Map<string, CommentableLines>();
  let page = 1;
  while (page <= 10) {
    const result = await withGitHubRetry(
      () =>
        listFiles({
          owner: env.repoOwner,
          repo: env.repoName,
          pull_number: parseInt(env.prNumber, 10),
          per_page: 100,
          page,
        }),
      { label: "listFiles" },
    );
    const files = result.data as Array<{ filename: string; patch?: string }>;
    for (const file of files) {
      map.set(file.filename, commentableLinesForPatch(file.patch));
    }
    if (files.length < 100) break;
    page++;
  }
  return map;
}

async function fetchPriorElekFindingIds(
  octokit: PostBufferedOctokit,
  env: PostBufferedDeps["env"],
  log: (msg: string) => void,
): Promise<Set<string>> {
  const listReviewComments = octokit.pulls.listReviewComments;
  if (!listReviewComments) return new Set();

  const ids = new Set<string>();
  try {
    let page = 1;
    while (page <= 10) {
      const result = await withGitHubRetry(
        () =>
          listReviewComments({
            owner: env.repoOwner,
            repo: env.repoName,
            pull_number: parseInt(env.prNumber, 10),
            per_page: 100,
            page,
          }),
        { label: "listReviewComments", log },
      );
      const comments = result.data as Array<{ body?: string }>;
      for (const comment of comments) {
        for (const id of extractFindingIds(comment.body)) ids.add(id);
      }
      if (comments.length < 100) break;
      page++;
    }
  } catch (err) {
    log(`prior elek finding lookup unavailable — ${err instanceof Error ? err.message : String(err)}`);
  }
  return ids;
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
  const priorFindingIds = await fetchPriorElekFindingIds(deps.octokit, deps.env, log);
  const newFindingIds = new Set<string>();
  let commentableMap: Map<string, CommentableLines> | null = null;
  try {
    commentableMap = await buildCommentableMap(deps.octokit, deps.env);
  } catch (err) {
    log(`diff-anchor validation unavailable — ${err instanceof Error ? err.message : String(err)}`);
  }

  // We need the PR head SHA when an entry didn't store its own commit_id.
  // Fetch once, lazily — and cache failures too: if pulls.get fails on the
  // first call (bad token, rate limit), retrying for every subsequent
  // entry just amplifies the API spam.
  let headShaResolved: string | null | undefined; // undefined=not yet, null=failed
  const ensureHeadSha = async (): Promise<string> => {
    if (typeof headShaResolved === "string") return headShaResolved;
    if (headShaResolved === null) throw new Error("PR head SHA unavailable (prior fetch failed)");
    try {
      const pr = await withGitHubRetry(
        () =>
          deps.octokit.pulls.get({
            owner: deps.env.repoOwner,
            repo: deps.env.repoName,
            pull_number: parseInt(deps.env.prNumber, 10),
          }),
        { label: "pulls.get" },
      );
      const sha = pr.data.head.sha as string;
      headShaResolved = sha;
      return sha;
    } catch (err) {
      headShaResolved = null;
      throw err;
    }
  };

  const prepared: Array<Record<string, unknown>> = [];

  for (const entry of entries) {
    if (entry.confirmed === false) {
      summary.skipped++;
      log(`skipped (confirmed=false) ${entry.path}:${entry.line}`);
      continue;
    }
    if (commentableMap) {
      const invalidReason = isEntryCommentable(entry, commentableMap);
      if (invalidReason) {
        summary.skipped++;
        log(`skipped ${entry.path}:${entry.line} — ${invalidReason}`);
        continue;
      }
    }
    const findingId = stableInlineFindingId(entry);
    if (priorFindingIds.has(findingId) || newFindingIds.has(findingId)) {
      summary.skipped++;
      summary.duplicate = (summary.duplicate ?? 0) + 1;
      log(`skipped duplicate elek finding ${findingId} ${entry.path}:${entry.line}`);
      continue;
    }
    newFindingIds.add(findingId);

    const params = buildReviewCommentParams(
      { ...entry, body: appendFindingMarker(entry.body, findingId) },
      deps.env,
      entry.commit_id ?? (await ensureHeadSha()),
    );
    prepared.push(params);
  }

  if (prepared.length === 0) return summary;

  const commitIds = new Set(
    prepared
      .map((params) => params.commit_id)
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  );

  if (deps.octokit.pulls.createReview && commitIds.size === 1) {
    const createReview = deps.octokit.pulls.createReview;
    try {
      const [commitId] = [...commitIds];
      await withGitHubRetry(
        () =>
          createReview({
            owner: deps.env.repoOwner,
            repo: deps.env.repoName,
            pull_number: parseInt(deps.env.prNumber, 10),
            event: "COMMENT",
            commit_id: commitId,
            comments: prepared.map(toCreateReviewComment),
          }),
        { label: "createReview", log: log },
      );
      summary.posted += prepared.length;
      log(`posted grouped review with ${prepared.length} inline comment(s)`);
      return summary;
    } catch (err) {
      log(
        `grouped review failed; falling back to individual comments — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  for (const params of prepared) {
    try {
      await withGitHubRetry(() => deps.octokit.pulls.createReviewComment(params), {
        label: "createReviewComment",
        log: log,
      });
      summary.posted++;
      log(`posted ${params.path}:${params.line}`);
    } catch (err) {
      summary.failed++;
      log(
        `failed ${params.path}:${params.line} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return summary;
}
