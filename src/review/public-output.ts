import { sanitize } from "../mcp/handlers.js";
import { hasInternalDeliveryMarker } from "./delivery-patterns.js";

export interface PublicReviewOutput {
  body: string;
  usable: boolean;
  filtered: boolean;
  removedParagraphs: number;
}

const GENERIC_FAILURE =
  "Elek could not complete this review run. See the workflow logs for details.";
const GENERIC_INTERNAL_ONLY =
  "Elek completed the model run, but the model did not return a usable public review. No public findings were posted from that response.";
const REVIEW_HEADING_KEYWORDS =
  "review|finding|recommendation|security|correctness|performance|maintainability|bug|regression|race|leak|validation|cleanup|issue|concern|quality|design|architecture|coverage|testing|health|change";

const REVIEW_SIGNAL_PATTERNS = [
  new RegExp(`^#{2,3}\\s+(?=.*\\b(?:${REVIEW_HEADING_KEYWORDS})\\b).+`, "im"),
  /^\s*[-*]\s+(?:Severity|Confidence|Path|Line|Evidence|Impact|Fix)\s*:/im,
  /\bNo high-confidence\b/i,
  /\bReview Summary\b/i,
  /\bFindings\b/i,
];

const REVIEW_SIGNAL_LINE_PATTERNS = [
  new RegExp(`^#{2,3}\\s+(?=.*\\b(?:${REVIEW_HEADING_KEYWORDS})\\b).+`, "i"),
  /^\s*[-*]\s+(?:Severity|Confidence|Path|Line|Evidence|Impact|Fix)\s*:/i,
  /\bNo high-confidence\b/i,
  /\bReview Summary\b/i,
  /\bFindings\b/i,
];

export function preparePublicReviewOutput(
  output: string,
  conclusion: "success" | "failure",
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

  const body = footerStripped.paragraphs.join("\n\n").trim();
  if (!body || !hasReviewSignal(body)) {
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

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function hasReviewSignal(text: string): boolean {
  return REVIEW_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
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

function hasReviewSignalLine(line: string): boolean {
  return REVIEW_SIGNAL_LINE_PATTERNS.some((pattern) => pattern.test(line));
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
    /^<!--\s*elek-bot(?::[^>]*)?\s*-->$/i.test(line)
  );
}
