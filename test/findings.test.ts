import { describe, expect, it } from "bun:test";
import { parseReviewFindings } from "../src/review/findings";

describe("review finding parser", () => {
  it("extracts structured finding fields from review markdown", () => {
    const findings = parseReviewFindings(`
## Review Summary

### Missing tenant check
- Severity: critical
- Confidence: high
- Path: \`src/auth.ts\`
- Line: 42
- Evidence: request tenant is not compared with session tenant
- Impact: users can read another tenant's records
- Fix: reject mismatched tenant ids before querying

### Low-value note
This paragraph has no review contract fields.

### Weak cache cleanup
- Severity: minor
- Confidence: medium
- Path: body-only
- Line: body-only
- Evidence: cache keys are not documented
- Impact: future changes are harder to validate
- Fix: add a focused cache invariant test
`);

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      title: "Missing tenant check",
      severity: "critical",
      confidence: "high",
      path: "src/auth.ts",
      line: "42",
      evidence: "request tenant is not compared with session tenant",
      impact: "users can read another tenant's records",
      fix: "reject mismatched tenant ids before querying",
    });
    expect(findings[1]).toMatchObject({
      title: "Weak cache cleanup",
      severity: "minor",
      confidence: "medium",
      path: "body-only",
    });
  });

  it("keeps unknown enum values explicit instead of throwing", () => {
    const findings = parseReviewFindings(`
### Odd format
- Severity: informational
- Confidence: low
- Evidence: text
`);

    expect(findings).toEqual([expect.objectContaining({
      title: "Odd format",
      severity: "unknown",
      confidence: "unknown",
      evidence: "text",
    })]);
  });

  it("stops a finding body at the next top-level review section", () => {
    const findings = parseReviewFindings(`
### Missing tenant check
- Severity: critical
- Confidence: high
- Path: src/auth.ts
- Line: 42
- Evidence: session tenant is ignored
- Impact: tenant isolation can fail
- Fix: compare tenant ids

## Recommendations

Mentioning unrelated benchmark words here should not enter the finding body.
`);

    expect(findings).toHaveLength(1);
    expect(findings[0].body).not.toContain("Recommendations");
    expect(findings[0].body).not.toContain("benchmark words");
  });
});
