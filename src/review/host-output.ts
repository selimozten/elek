import { appendFindingMarker, stableInlineFindingId } from "./finding-markers.js";
import { redactPublicationSecrets } from "../redaction.js";

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

export function sanitize(body: string): string {
  return redactPublicationSecrets(body);
}
