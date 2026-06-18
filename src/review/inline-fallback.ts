import type { ParsedReviewFinding } from "./findings.js";

interface InlineFindingEntry {
  path: string;
  body: string;
  line: number;
  startLine?: number;
  confirmed: true;
}

export function inlineReviewBufferFromFindings(findings: ParsedReviewFinding[]): string {
  const entries = findings
    .map(inlineEntryFromFinding)
    .filter((entry): entry is InlineFindingEntry => entry !== null);

  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function inlineEntryFromFinding(finding: ParsedReviewFinding): InlineFindingEntry | null {
  if (finding.confidence !== "high" && finding.confidence !== "medium") return null;
  if (finding.severity !== "critical" && finding.severity !== "important" && finding.severity !== "minor") {
    return null;
  }
  if (!finding.path || finding.path === "body-only" || finding.path === "(unknown)") return null;

  const anchor = lineAnchor(finding.line);
  if (!anchor) return null;

  return {
    path: finding.path,
    body: [`### ${finding.title}`, "", finding.body].join("\n").trim(),
    ...anchor,
    confirmed: true,
  };
}

function lineAnchor(line: string): { line: number; startLine?: number } | null {
  const normalized = line.trim().replace(/^`|`$/g, "");
  const single = normalized.match(/^(\d+)$/);
  if (single) return { line: Number(single[1]) };

  const range = normalized.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (!range) return null;

  const startLine = Number(range[1]);
  const endLine = Number(range[2]);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) return null;
  if (startLine <= 0 || endLine <= 0 || startLine > endLine) return null;
  return { startLine, line: endLine };
}
