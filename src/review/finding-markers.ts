import { createHash } from "node:crypto";

const FINDING_MARKER_RE = /<!--\s*elek-finding:v1\s+id=([a-f0-9]{16,64})\s*-->/gi;

export function stripFindingMarkers(body: string): string {
  return body.replace(FINDING_MARKER_RE, "").trim();
}

export function extractFindingIds(body: string | undefined): string[] {
  if (!body) return [];
  const ids: string[] = [];
  for (const match of body.matchAll(FINDING_MARKER_RE)) {
    ids.push(match[1].toLowerCase());
  }
  return ids;
}

export function stableInlineFindingId(input: { path: string; body: string }): string {
  const normalizedBody = stripFindingMarkers(input.body)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4_000);
  return createHash("sha256")
    .update(`${input.path}\n${normalizedBody}`)
    .digest("hex")
    .slice(0, 16);
}

export function appendFindingMarker(body: string, id: string): string {
  if (extractFindingIds(body).includes(id.toLowerCase())) return body;
  return `${stripFindingMarkers(body)}\n\n<!-- elek-finding:v1 id=${id.toLowerCase()} -->`;
}
