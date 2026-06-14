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
  const headings = [...text.matchAll(FINDING_HEADING)];
  const findings: ParsedReviewFinding[] = [];
  const usedIds = new Map<string, number>();

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

export function findingId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `finding-${index + 1}`;
}

export function uniqueFindingId(title: string, index: number, usedIds: Map<string, number>): string {
  const baseId = findingId(title, index);
  const count = usedIds.get(baseId) ?? 0;
  usedIds.set(baseId, count + 1);
  return count === 0 ? baseId : `${baseId}-${count}`;
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
