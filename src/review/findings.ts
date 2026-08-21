export interface ParsedReviewFinding {
  id?: string;
  title: string;
  severity: "critical" | "important" | "minor" | "unknown";
  confidence: "high" | "medium" | "unknown";
  path: string;
  line: string;
  evidence: string;
  impact: string;
  fix: string;
  body: string;
}

const FINDING_HEADING = /^###\s+(.+)$/gm;
// No "g" flag: each exec call must return the first heading in a fresh slice.
const SECTION_OR_FINDING_HEADING = /^#{2,3}\s+/m;

export function parseReviewFindings(text: string): ParsedReviewFinding[] {
  const conciseFindings = parseConciseReviewFindings(text);
  if (conciseFindings.length > 0) return conciseFindings;

  const headings = [...text.matchAll(FINDING_HEADING)];
  const findings: ParsedReviewFinding[] = [];
  const usedIds = new Set<string>();

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const title = (heading[1] ?? "").trim();
    const start = heading.index ?? 0;
    const bodyStart = start + heading[0].length;
    const rawBody = text.slice(bodyStart);
    const nextHeading = SECTION_OR_FINDING_HEADING.exec(rawBody);
    const body = rawBody.slice(0, nextHeading?.index ?? rawBody.length).trim();
    const fields = fieldsFromFindingBody(body);
    if (!fields.severity && !fields.confidence && !fields.evidence && !fields.impact && !fields.fix) {
      continue;
    }

    findings.push({
      id: uniqueFindingId(title, findings.length, usedIds),
      title,
      severity: severityValue(fields.severity),
      confidence: confidenceValue(fields.confidence),
      path: cleanField(fields.path),
      line: cleanField(fields.line),
      evidence: cleanField(fields.evidence),
      impact: cleanField(fields.impact),
      fix: cleanField(fields.fix),
      body,
    });
  }

  return findings;
}

function parseConciseReviewFindings(text: string): ParsedReviewFinding[] {
  const findings: ParsedReviewFinding[] = [];
  const usedIds = new Set<string>();
  let severity: ParsedReviewFinding["severity"] = "unknown";

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(?:###\s+|\*\*)([🔴🟡🟢])\s+(Blocker|Important|Nit)(?:\*\*)?$/u);
    if (heading) {
      severity = heading[2] === "Blocker"
        ? "critical"
        : heading[2] === "Important"
          ? "important"
          : "minor";
      continue;
    }

    const bullet = line.match(/^-\s+`(.+):(\d+)`\s+—\s+(.+)$/);
    if (!bullet || severity === "unknown") continue;
    const evidence = bullet[3].trim();
    const title = conciseFindingTitle(evidence);
    findings.push({
      id: uniqueFindingId(title, findings.length, usedIds),
      title,
      severity,
      confidence: "high",
      path: bullet[1].trim(),
      line: bullet[2],
      evidence,
      impact: evidence,
      fix: "",
      body: line,
    });
  }

  return findings;
}

function conciseFindingTitle(evidence: string): string {
  const firstClause = evidence.split(/(?<=[.!?])\s+/, 1)[0]?.replace(/[.!?]+$/, "").trim();
  return (firstClause || "Review finding").slice(0, 120);
}

export function findingId(title: string, index: number): string {
  // Keep slug rules in sync with bin/elek-feedback.mjs for old summaries without IDs.
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `finding-${index + 1}`;
}

export function uniqueFindingId(
  title: string,
  index: number,
  usedIds: Set<string>,
  preferredId = "",
): string {
  const baseId = preferredId.trim() || findingId(title, index);
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }
  let count = 1;
  let candidate = `${baseId}-${count}`;
  while (usedIds.has(candidate)) {
    count++;
    candidate = `${baseId}-${count}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function fieldsFromFindingBody(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+\**([A-Za-z ]+)\**\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, "");
    fields[key] = match[2].trim();
  }
  return fields;
}

function severityValue(value: string | undefined): ParsedReviewFinding["severity"] {
  const normalized = cleanField(value).toLowerCase();
  if (normalized === "critical" || normalized === "important" || normalized === "minor") return normalized;
  return "unknown";
}

function confidenceValue(value: string | undefined): ParsedReviewFinding["confidence"] {
  const normalized = cleanField(value).toLowerCase();
  if (normalized === "high" || normalized === "medium") return normalized;
  return "unknown";
}

function cleanField(value: string | undefined): string {
  return (value ?? "")
    .replace(/^`|`$/g, "")
    .replace(/^"|"$/g, "")
    .trim();
}
