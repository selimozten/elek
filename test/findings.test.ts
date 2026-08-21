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
      id: "missing-tenant-check",
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
      id: "weak-cache-cleanup",
      title: "Weak cache cleanup",
      severity: "minor",
      confidence: "medium",
      path: "body-only",
    });
  });

  it("assigns stable unique ids to findings", () => {
    const findings = parseReviewFindings(`
### Foo
- Severity: minor
- Evidence: a

### Foo
- Severity: minor
- Evidence: b

### Foo 1
- Severity: minor
- Evidence: c

### !!!
- Severity: minor
- Evidence: d
`);

    expect(findings.map((finding) => finding.id)).toEqual([
      "foo",
      "foo-1",
      "foo-1-1",
      "finding-4",
    ]);
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

  it("parses the concise verdict format used by the Claude reviewer", () => {
    const findings = parseReviewFindings([
      "Verdict: approve-with-amendments — one issue needs attention",
      "",
      "### 🟡 Important",
      "- `src/auth.ts:42` — the lookup omits tenant_id. Users can read another tenant's data.",
    ].join("\n"));

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "important",
        confidence: "high",
        path: "src/auth.ts",
        line: "42",
        evidence: "the lookup omits tenant_id. Users can read another tenant's data.",
      }),
    ]);
  });
});
