/**
 * Post-step: drains the inline-comment buffer left by the MCP server during
 * the pi run, and posts each surviving entry as a real PR review comment.
 *
 * Pure orchestration logic lives in `postBuffered(deps)`; the file's bottom
 * runs it against real fs/octokit when invoked as a CLI.
 */
import { buildReviewCommentParams } from "../mcp/handlers";

/**
 * Narrow Octokit slice the post-step uses. `any` for params + responses to
 * accept either @actions/github (.rest) or @octokit/rest (.) variants;
 * Octokit's full generic types don't structurally fit a hand-rolled subset.
 */
export type PostBufferedOctokit = {
  pulls: {
    createReviewComment: (params: any) => Promise<any>;
    get: (params: any) => Promise<any>;
    listFiles?: (params: any) => Promise<any>;
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

interface CommentableLines {
  RIGHT: Set<number>;
  LEFT: Set<number>;
}

export function commentableLinesForPatch(patch: string | undefined): CommentableLines {
  const RIGHT = new Set<number>();
  const LEFT = new Set<number>();
  if (!patch) return { RIGHT, LEFT };

  let oldLine = 0;
  let newLine = 0;
  for (const row of patch.split("\n")) {
    const hunk = row.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }

    const marker = row[0];
    if (marker === "+") {
      RIGHT.add(newLine);
      newLine++;
    } else if (marker === "-") {
      LEFT.add(oldLine);
      oldLine++;
    } else if (marker === " ") {
      RIGHT.add(newLine);
      LEFT.add(oldLine);
      newLine++;
      oldLine++;
    }
  }

  return { RIGHT, LEFT };
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

async function buildCommentableMap(
  octokit: PostBufferedOctokit,
  env: PostBufferedDeps["env"],
): Promise<Map<string, CommentableLines> | null> {
  if (!octokit.pulls.listFiles) return null;

  const map = new Map<string, CommentableLines>();
  let page = 1;
  while (page <= 10) {
    const result = await octokit.pulls.listFiles({
      owner: env.repoOwner,
      repo: env.repoName,
      pull_number: parseInt(env.prNumber, 10),
      per_page: 100,
      page,
    });
    const files = result.data as Array<{ filename: string; patch?: string }>;
    for (const file of files) {
      map.set(file.filename, commentableLinesForPatch(file.patch));
    }
    if (files.length < 100) break;
    page++;
  }
  return map;
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
      const pr = await deps.octokit.pulls.get({
        owner: deps.env.repoOwner,
        repo: deps.env.repoName,
        pull_number: parseInt(deps.env.prNumber, 10),
      });
      const sha = pr.data.head.sha as string;
      headShaResolved = sha;
      return sha;
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
    if (commentableMap) {
      const invalidReason = isEntryCommentable(entry, commentableMap);
      if (invalidReason) {
        summary.skipped++;
        log(`skipped ${entry.path}:${entry.line} — ${invalidReason}`);
        continue;
      }
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
