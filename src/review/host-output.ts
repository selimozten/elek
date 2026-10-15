import { appendFindingMarker, stableInlineFindingId } from "./finding-markers.js";

export interface ReviewCommentEntry {
  path: string;
  body: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  commit_id?: string;
}

export function buildReviewCommentParams(
  entry: ReviewCommentEntry,
  env: { repoOwner: string; repoName: string; prNumber: string },
  fallbackSha: string,
): Record<string, unknown> {
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
  if (entry.line !== undefined) params.line = entry.line;
  if (entry.startLine !== undefined) {
    params.start_line = entry.startLine;
    params.start_side = side;
  }
  return params;
}

// High-confidence secret shapes only: review prose legitimately contains
// commit SHAs, code blocks, and email-like examples, so broader patterns
// would mangle real findings.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[psour]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** Redact secrets from text before it is posted to GitHub or logged. */
export function sanitize(body: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), body);
}
