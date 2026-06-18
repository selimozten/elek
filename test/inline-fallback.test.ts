import { describe, expect, it } from "bun:test";
import { parseReviewFindings } from "../src/review/findings";
import { inlineReviewBufferFromFindings } from "../src/review/inline-fallback";

describe("inline finding fallback", () => {
  it("turns exact line-anchored final findings into confirmed inline entries", () => {
    const findings = parseReviewFindings([
      "## Findings",
      "",
      "### Missing tenant check",
      "- Severity: critical",
      "- Confidence: high",
      "- Path: `src/auth.ts`",
      "- Line: 42",
      "- Evidence: the lookup omits tenant_id",
      "- Impact: cross-tenant reads become possible",
      "- Fix: add tenant_id to the query predicate",
    ].join("\n"));

    const lines = inlineReviewBufferFromFindings(findings).split("\n");
    const entry = JSON.parse(lines[0]);

    expect(lines).toHaveLength(1);
    expect(entry).toMatchObject({
      path: "src/auth.ts",
      line: 42,
      confirmed: true,
    });
    expect(entry.body).toContain("### Missing tenant check");
  });

  it("keeps simple ranges and skips body-only or fuzzy line findings", () => {
    const findings = parseReviewFindings([
      "### Range finding",
      "- Severity: important",
      "- Confidence: medium",
      "- Path: `src/server.ts`",
      "- Line: 12-14",
      "- Evidence: range evidence",
      "- Impact: range impact",
      "- Fix: range fix",
      "",
      "### Body only finding",
      "- Severity: important",
      "- Confidence: high",
      "- Path: `src/server.ts`",
      "- Line: body-only",
      "- Evidence: body evidence",
      "- Impact: body impact",
      "- Fix: body fix",
      "",
      "### Fuzzy finding",
      "- Severity: important",
      "- Confidence: high",
      "- Path: `src/server.ts`",
      "- Line: ~464",
      "- Evidence: fuzzy evidence",
      "- Impact: fuzzy impact",
      "- Fix: fuzzy fix",
    ].join("\n"));

    const entries = inlineReviewBufferFromFindings(findings)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: "src/server.ts",
      startLine: 12,
      line: 14,
      confirmed: true,
    });
  });
});
