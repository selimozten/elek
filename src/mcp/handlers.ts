/**
 * Review-only MCP handlers — pure functions, no MCP SDK, no real I/O.
 * The server shim wires these into McpServer; tests import them directly.
 */
import { appendFindingMarker, stableInlineFindingId } from "../review/finding-markers.js";
import { hasInternalDeliveryMarker } from "../review/delivery-patterns.js";

export interface OctokitLike {
  pulls: {
    createReviewComment(params: unknown): Promise<{
      data: { id: number; html_url: string; path: string; line?: number; original_line?: number };
    }>;
    get(params: unknown): Promise<{ data: { head: { sha: string } } }>;
  };
  issues: {
    updateComment(params: unknown): Promise<{ data: { id: number; html_url: string } }>;
  };
}

export interface Deps {
  octokit: OctokitLike;
  appendBuffer: (line: string) => void;
  env: {
    repoOwner: string;
    repoName: string;
    prNumber: string;
    trackingCommentId?: string;
  };
  now?: () => Date;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export interface UpdateTrackingCommentArgs {
  body: string;
}

export async function updateTrackingComment(
  deps: Deps,
  args: UpdateTrackingCommentArgs,
): Promise<ToolResult> {
  const id = deps.env.trackingCommentId;
  if (!id) {
    return { ok: false, error: "trackingCommentId is not set in env" };
  }
  const numericId = parseInt(id, 10);
  if (!Number.isFinite(numericId)) {
    return { ok: false, error: `trackingCommentId "${id}" is not a valid number` };
  }
  const safeBody = sanitize(args.body);
  if (hasInternalDeliveryMarker(safeBody)) {
    return {
      ok: false,
      error: "tracking comment update rejected because body contains internal delivery/debug text",
    };
  }
  try {
    const result = await deps.octokit.issues.updateComment({
      owner: deps.env.repoOwner,
      repo: deps.env.repoName,
      comment_id: numericId,
      body: safeBody,
    });
    return { ok: true, data: result.data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CreateInlineCommentArgs {
  path: string;
  body: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  commit_id?: string;
  confirmed?: boolean;
}

export interface ReviewCommentEntry {
  path: string;
  body: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  commit_id?: string;
}

/**
 * Build the parameter shape for octokit.pulls.createReviewComment.
 * Used by both the live `confirmed:true` path and the post-step.
 */
export function buildReviewCommentParams(
  entry: ReviewCommentEntry,
  env: { repoOwner: string; repoName: string; prNumber: string },
  fallbackSha: string,
): Record<string, unknown> {
  const isMultiLine = entry.startLine !== undefined;
  const side = entry.side ?? "RIGHT";
  const params: Record<string, unknown> = {
    owner: env.repoOwner,
    repo: env.repoName,
    pull_number: parseInt(env.prNumber, 10),
    path: entry.path,
    body: appendFindingMarker(entry.body, stableInlineFindingId(entry)),
    side,
    commit_id: entry.commit_id ?? fallbackSha,
  };
  if (entry.line !== undefined) {
    params.line = entry.line;
  }
  if (isMultiLine) {
    params.start_line = entry.startLine;
    params.start_side = side;
  }
  return params;
}

/**
 * Redact common GitHub credential shapes from any string the model emits.
 * These never legitimately appear in a code-review comment, and a leak here
 * would persist forever in the GitHub UI.
 *   ghp_  classic personal access tokens
 *   ghs_  GitHub App / installation tokens
 *   gho_  OAuth tokens
 *   ghu_  user-to-server tokens
 *   github_pat_  fine-grained PATs (longer)
 */
export function sanitize(body: string): string {
  return body
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]");
}

export async function createInlineComment(
  deps: Deps,
  args: CreateInlineCommentArgs,
): Promise<ToolResult> {
  if (args.line === undefined && args.startLine === undefined) {
    return {
      ok: false,
      error: "Either 'line' (single-line) or 'startLine'+'line' (multi-line) must be provided",
    };
  }
  if (args.startLine !== undefined && args.line === undefined) {
    return {
      ok: false,
      error: "Multi-line comments require both 'startLine' and 'line' (the end line)",
    };
  }
  const safeBody = sanitize(args.body);
  if (hasInternalDeliveryMarker(safeBody)) {
    return {
      ok: false,
      error: "inline comment rejected because body contains internal delivery/debug text",
    };
  }

  if (args.confirmed !== true) {
    const ts = (deps.now ?? (() => new Date()))().toISOString();
    deps.appendBuffer(
      JSON.stringify({
        ts,
        path: args.path,
        line: args.line,
        startLine: args.startLine,
        side: args.side,
        commit_id: args.commit_id,
        body: safeBody,
        confirmed: args.confirmed,
      }) + "\n",
    );
    return { ok: true, data: { buffered: true } };
  }

  // confirmed === true → post directly via the GitHub API
  try {
    // Skip the pulls.get() round trip when the model already supplied a
    // commit_id — saves one API call (and one possible rate-limit hit) per
    // confirmed inline comment.
    let fallbackSha = "";
    if (!args.commit_id) {
      const pr = await deps.octokit.pulls.get({
        owner: deps.env.repoOwner,
        repo: deps.env.repoName,
        pull_number: parseInt(deps.env.prNumber, 10),
      });
      fallbackSha = pr.data.head.sha;
    }

    const params = buildReviewCommentParams(
      { ...args, body: safeBody },
      deps.env,
      fallbackSha,
    );

    const result = await deps.octokit.pulls.createReviewComment(params);
    return { ok: true, data: result.data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
