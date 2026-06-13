export const REVIEW_CONTRACT_FIELDS = [
  "Severity",
  "Confidence",
  "Evidence",
  "Impact",
  "Fix",
] as const;

export function reviewContractBullets(): string[] {
  return [
    "- Every finding must include severity, confidence, evidence, impact, and a concrete fix.",
    "- Severity must be one of: critical, important, minor.",
    "- Confidence must be high or medium. Do not surface low-confidence findings.",
    "- Evidence must point to changed code, visible context, or a verified repo fact.",
    "- Impact must describe the user, security, correctness, operations, or maintainability consequence.",
    "- Fix must describe the smallest concrete change that would resolve the issue.",
  ];
}

export function reviewFindingTemplate(): string[] {
  return [
    "### [critical|important|minor] Short title",
    "- Severity: critical|important|minor",
    "- Confidence: high|medium",
    "- Path: `path/to/file`",
    '- Line: new-diff line number if known, otherwise "body-only"',
    "- Evidence: quote or summarize the concrete code path",
    "- Impact: what breaks or gets harder to maintain",
    "- Fix: the smallest concrete change required",
  ];
}
