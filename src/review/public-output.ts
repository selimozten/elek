import { sanitize } from "../mcp/handlers.js";
import { hasInternalDeliveryMarker } from "./delivery-patterns.js";
import { hasMergeApprovalLanguage, hasReviewSignal, hasReviewSignalLine } from "./public-guards.js";
import { commentableLinesForPatch, parseUnifiedDiffFiles } from "./diff-context.js";

export interface PublicReviewOutput {
  body: string;
  usable: boolean;
  filtered: boolean;
  removedParagraphs: number;
}

export interface PublicReviewOutputOptions {
  internalModelLabels?: string[];
  publicModelLabel?: string;
  requireVerdictFormat?: boolean;
  severityThreshold?: "critical" | "important" | "minor" | "";
  diff?: string;
}

type ReviewSeverity = "critical" | "important" | "minor";

interface VerdictFinding {
  severity: ReviewSeverity;
  path: string;
  line: number;
  text: string;
}

const GENERIC_FAILURE =
  "Elek could not complete this review run. See the workflow logs for details.";
const GENERIC_INTERNAL_ONLY =
  "Elek completed the model run, but the model did not return a usable public review. No public findings were posted from that response.";

export function preparePublicReviewOutput(
  output: string,
  conclusion: "success" | "failure",
  options: PublicReviewOutputOptions = {},
): PublicReviewOutput {
  const safe = sanitize(output).trim();
  if (conclusion === "failure") {
    return {
      body: GENERIC_FAILURE,
      usable: false,
      filtered: safe.length > 0,
      removedParagraphs: safe ? splitParagraphs(safe).length : 0,
    };
  }

  const paragraphs = splitParagraphs(safe);
  const kept: string[] = [];
  let removedParagraphs = 0;
  let filtered = false;

  for (const paragraph of paragraphs) {
    if (!hasInternalDeliveryMarker(paragraph)) {
      kept.push(paragraph);
      continue;
    }

    filtered = true;
    const cleaned = paragraph
      .split("\n")
      .filter((line) => !hasInternalDeliveryMarker(line))
      .join("\n")
      .trim();
    if (cleaned && hasReviewSignal(cleaned)) {
      kept.push(cleaned);
    } else {
      removedParagraphs++;
    }
  }

  const preludeStripped = stripNonReviewPrelude(kept);
  if (preludeStripped.filtered) {
    filtered = true;
    removedParagraphs += preludeStripped.removedParagraphs;
  }

  const footerStripped = stripHostManagedFooter(preludeStripped.paragraphs);
  if (footerStripped.filtered) {
    filtered = true;
    removedParagraphs += footerStripped.removedParagraphs;
  }

  let body = redactInternalModelLabels(
    footerStripped.paragraphs.join("\n\n").trim(),
    options.internalModelLabels ?? [],
    options.publicModelLabel,
  );
  if (options.requireVerdictFormat) {
    const normalized = normalizeVerdictReviewOutput(
      body,
      options.severityThreshold || "minor",
      options.diff,
    );
    if (!normalized) {
      return {
        body: GENERIC_INTERNAL_ONLY,
        usable: false,
        filtered: true,
        removedParagraphs: Math.max(removedParagraphs, paragraphs.length),
      };
    }
    filtered ||= normalized.filtered;
    body = normalized.body;
  }

  if (!body || !hasReviewSignal(body) || hasMergeApprovalLanguage(body)) {
    return {
      body: GENERIC_INTERNAL_ONLY,
      usable: false,
      filtered: true,
      removedParagraphs: Math.max(removedParagraphs, paragraphs.length),
    };
  }

  return {
    body,
    usable: true,
    filtered,
    removedParagraphs,
  };
}

function normalizeVerdictReviewOutput(
  text: string,
  threshold: ReviewSeverity,
  diff: string | undefined,
): { body: string; filtered: boolean } | undefined {
  const verdictMatch = text.match(
    /^Verdict: (approve|approve-with-amendments|request-changes) — (.{5,120})$/m,
  );
  if (!verdictMatch || verdictMatch.index !== 0) return undefined;

  const commentable = commentableLinesByPath(diff);
  const findings: VerdictFinding[] = [];
  const seen = new Set<string>();
  let severity: ReviewSeverity | undefined;

  for (const line of text.split(/\r?\n/).slice(1)) {
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
    if (!bullet || !severity || !meetsThreshold(severity, threshold)) continue;
    const path = bullet[1].trim();
    const lineNumber = Number(bullet[2]);
    if (!Number.isSafeInteger(lineNumber) || lineNumber <= 0) continue;
    if (commentable && !commentable.get(path)?.has(lineNumber)) continue;

    const key = `${severity}\0${path}\0${lineNumber}\0${bullet[3].trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ severity, path, line: lineNumber, text: bullet[3].trim() });
  }

  const capped = (["critical", "important", "minor"] as const)
    .flatMap((tier) => findings.filter((finding) => finding.severity === tier).slice(0, 5));
  const expectedVerdict = capped.some((finding) => finding.severity === "critical")
    ? "request-changes"
    : capped.length > 0
      ? "approve-with-amendments"
      : "approve";
  const changed = capped.length !== findings.length || canonicalFindingCount(text) !== capped.length;
  const reason = !changed && verdictMatch[1] === expectedVerdict
    ? verdictMatch[2]
    : verdictReason(capped, threshold);
  const sections = (["critical", "important", "minor"] as const)
    .map((tier) => formatVerdictSection(tier, capped.filter((finding) => finding.severity === tier)))
    .filter(Boolean);
  const body = [
    `Verdict: ${expectedVerdict} — ${reason}`,
    ...sections,
  ].join("\n\n");

  return { body, filtered: body !== text.trim() };
}

function commentableLinesByPath(diff: string | undefined): Map<string, Set<number>> | undefined {
  if (!diff) return undefined;
  const files = parseUnifiedDiffFiles(diff);
  if (files.length === 0) return new Map();
  return new Map(files.map((file) => [file.path, commentableLinesForPatch(file.patch).RIGHT]));
}

function meetsThreshold(severity: ReviewSeverity, threshold: ReviewSeverity): boolean {
  const rank: Record<ReviewSeverity, number> = { critical: 3, important: 2, minor: 1 };
  return rank[severity] >= rank[threshold];
}

function canonicalFindingCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => /^-\s+`.+:\d+`\s+—\s+.+$/.test(line)).length;
}

function verdictReason(findings: VerdictFinding[], threshold: ReviewSeverity): string {
  const blockers = findings.filter((finding) => finding.severity === "critical").length;
  if (blockers > 0) return `${countWord(blockers)} Blocker finding${blockers === 1 ? " requires" : "s require"} changes`;
  const important = findings.filter((finding) => finding.severity === "important").length;
  if (important > 0) return `${countWord(important)} Important finding${important === 1 ? " needs" : "s need"} attention`;
  const nits = findings.filter((finding) => finding.severity === "minor").length;
  if (nits > 0) return `${countWord(nits)} Nit finding${nits === 1 ? " needs" : "s need"} attention`;
  return threshold === "minor"
    ? "no review findings"
    : "no Blocker or Important findings";
}

function countWord(count: number): string {
  return count === 1 ? "one" : String(count);
}

function formatVerdictSection(severity: ReviewSeverity, findings: VerdictFinding[]): string {
  if (findings.length === 0) return "";
  const heading = severity === "critical"
    ? "### 🔴 Blocker"
    : severity === "important"
      ? "### 🟡 Important"
      : "### 🟢 Nit";
  return [
    heading,
    ...findings.map((finding) => `- \`${finding.path}:${finding.line}\` — ${finding.text}`),
  ].join("\n");
}

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function stripNonReviewPrelude(paragraphs: string[]): {
  paragraphs: string[];
  filtered: boolean;
  removedParagraphs: number;
} {
  const firstReviewParagraph = paragraphs.findIndex(hasReviewSignal);
  if (firstReviewParagraph < 0) {
    return { paragraphs, filtered: false, removedParagraphs: 0 };
  }

  const stripped = paragraphs.slice(firstReviewParagraph);
  let trimmedFirstLinePrelude = false;
  const first = stripped[0];
  if (first) {
    stripped[0] = stripLeadingLinesBeforeReviewSignal(first);
    trimmedFirstLinePrelude = stripped[0] !== first;
  }

  return {
    paragraphs: stripped.filter(Boolean),
    filtered: firstReviewParagraph > 0 || trimmedFirstLinePrelude,
    removedParagraphs: firstReviewParagraph,
  };
}

function stripLeadingLinesBeforeReviewSignal(paragraph: string): string {
  const lines = paragraph.split("\n");
  const firstReviewLine = lines.findIndex(hasReviewSignalLine);
  if (firstReviewLine <= 0) return paragraph;
  return lines.slice(firstReviewLine).join("\n").trim();
}

function stripHostManagedFooter(paragraphs: string[]): {
  paragraphs: string[];
  filtered: boolean;
  removedParagraphs: number;
} {
  const stripped = [...paragraphs];
  let removedParagraphs = 0;
  while (stripped.length > 0 && isHostManagedFooterParagraph(stripped[stripped.length - 1])) {
    stripped.pop();
    removedParagraphs++;
  }
  return {
    paragraphs: stripped,
    filtered: removedParagraphs > 0,
    removedParagraphs,
  };
}

function isHostManagedFooterParagraph(paragraph: string): boolean {
  const lines = paragraph
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every(isHostManagedFooterLine);
}

function isHostManagedFooterLine(line: string): boolean {
  return (
    /^_?(?:estimated\s+review\s+cost|review\s+cost):\s+.+_?$/i.test(line) ||
    /^\[view run\]\(https?:\/\/[^)]+\/actions\/runs\/[^)]+\)$/i.test(line) ||
    /^_?\*?.+?\s+·\s+\[view run\]\(https?:\/\/[^)]+\/actions\/runs\/[^)]+\)\*?_?$/i.test(line) ||
    /^<!--\s*elek-bot(?::[^>]*)?\s*-->$/i.test(line)
  );
}

function redactInternalModelLabels(
  text: string,
  internalModelLabels: string[],
  publicModelLabel: string | undefined,
): string {
  const replacement = publicModelLabel?.trim();
  if (!text || !replacement) return text;
  return internalModelLabels
    .map((label) => label.trim())
    .filter((label) => label && label !== replacement)
    .sort((a, b) => b.length - a.length)
    .reduce(
      (current, label) => current.replace(new RegExp(escapeRegExp(label), "g"), replacement),
      text,
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
