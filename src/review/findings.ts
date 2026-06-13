export interface ParsedReviewFinding {
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
const SECTION_OR_FINDING_HEADING = /^#{2,3}\s+/m;

export function parseReviewFindings(text: string): ParsedReviewFinding[] {
  const headings = [...text.matchAll(FINDING_HEADING)];
  const findings: ParsedReviewFinding[] = [];

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
