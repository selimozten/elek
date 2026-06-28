// Shared secret / PII detection and redaction helpers for the review engine.
//
// Two tiers are exposed because the false-positive tolerance differs by sink:
//
//   - publication (public GitHub comments + runner logs): free-form review
//     prose legitimately contains commit SHAs (40 hex), code blocks, and
//     email-like examples, so only the highest-confidence secret shapes that
//     NEVER legitimately appear in a review comment are redacted there.
//   - telemetry (structured metadata sent to the cloud): fields are short
//     labels/ids, and the model-lab redaction guard already enforces the full
//     set (including long hex/base64 and emails) there. Mirror that set so the
//     client and the offline evaluator reject the same shapes.
//
// This mirrors elek-cloud/src/redaction.ts and elek-model-lab/scripts/validate-fixtures.mjs.

export type SecretLabel = string;

// Match shapes (no flags) used both for detection and as the basis for the
// global-flag publication redaction patterns below.
const githubTokenShape = "(?:gh[psour]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})";
const apiKeyShape = "sk-[A-Za-z0-9_-]{16,}";
const awsKeyShape = "(?:AKIA|ASIA)[A-Z0-9]{16}";
const jwtShape = "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}";
const longOpaqueShape = "[A-Fa-f0-9]{40,}|[A-Za-z0-9_-]{48,}";
const emailShape = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";

// Narrow, high-confidence patterns for public comment / log redaction. A match
// here is always a secret, never legitimate review prose (SHAs / code blocks /
// email examples are intentionally NOT matched here).
const publicationSecretPatterns: ReadonlyArray<[SecretLabel, RegExp]> = [
  ["github token", new RegExp(`\\b${githubTokenShape}\\b`, "g")],
  ["api key (sk-)", new RegExp(`\\b${apiKeyShape}\\b`, "g")],
  ["aws access key id", new RegExp(`\\b${awsKeyShape}\\b`, "g")],
  ["jwt", new RegExp(`\\b${jwtShape}\\b`, "g")],
];

// Full pattern set for structured telemetry value detection. Adds long opaque
// secrets and emails/PII, which are safe to reject in short metadata fields
// (and would be false positives in free-form review prose).
const telemetrySecretPatterns: ReadonlyArray<[SecretLabel, RegExp]> = [
  ["github token", new RegExp(`\\b${githubTokenShape}\\b`)],
  ["api key (sk-)", new RegExp(`\\b${apiKeyShape}\\b`)],
  ["aws access key id", new RegExp(`\\b${awsKeyShape}\\b`)],
  ["jwt", new RegExp(`\\b${jwtShape}\\b`)],
  ["long hex/base64 secret", new RegExp(`\\b${longOpaqueShape}\\b`)],
  ["email address", new RegExp(`\\b${emailShape}\\b`)],
];

// Redacts detected high-confidence secret substrings from public review text /
// logs, replacing each match with [REDACTED]. Narrow by design (see above).
export function redactPublicationSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const [, pattern] of publicationSecretPatterns) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

// Returns a human-readable match label if the value looks like a secret/PII
// (full telemetry set), otherwise null. Used to reject smuggled secrets in
// structured telemetry before it leaves the client.
export function detectSecretValue(value: unknown): SecretLabel | null {
  if (typeof value !== "string") return null;
  for (const [label, pattern] of telemetrySecretPatterns) {
    if (pattern.test(value)) return label;
  }
  return null;
}