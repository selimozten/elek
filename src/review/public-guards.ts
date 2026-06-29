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

export function hasReviewSignal(text: string): boolean {
  return REVIEW_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasReviewSignalLine(line: string): boolean {
  return REVIEW_SIGNAL_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

export function hasMergeApprovalLanguage(text: string): boolean {
  const normalized = text.toLowerCase();
  if (/\b(?:lgtm|ship it)\b/.test(normalized)) return true;
  if (/\bsafe to merge\b/.test(normalized) && !/\b(?:not|never|isn't|is not|cannot be|should not be|unsafe)\s+safe to merge\b/.test(normalized)) {
    return true;
  }
  return false;
}
