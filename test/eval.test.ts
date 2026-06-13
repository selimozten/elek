import { describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

describe("elek-eval", () => {
  it("scores saved review summaries against a seeded benchmark suite", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-eval-test-"));
    try {
      const suitePath = join(dir, "suite.yml");
      const summaryPath = join(dir, "summary.json");
      writeFileSync(suitePath, `
version: 1
cases:
  - id: auth-regression
    repository: acme/app
    number: 42
    expected_findings:
      - id: tenant-bypass
        min_severity: critical
        keywords: [tenant, session, bypass]
    max_false_positives: 1
`);
      writeFileSync(summaryPath, JSON.stringify({
        version: 1,
        repository: "acme/app",
        run: { durationSeconds: 12.3 },
        entity: { number: 42 },
        review: {
          finalModel: "deepseek/deepseek-v4-pro",
          executedStrategy: "crosscheck",
        },
        cost: { usd: 0.0042 },
        findings: [{
          title: "Tenant session bypass",
          severity: "critical",
          confidence: "high",
          path: "src/auth.ts",
          line: "42",
          evidence: "tenant is taken from request while session tenant is ignored",
          impact: "tenant isolation can be bypassed",
          fix: "compare the request tenant with the session tenant",
        }, {
          title: "Extra note",
          severity: "minor",
          confidence: "medium",
          evidence: "style issue",
        }],
      }));

      const output = execFileSync("node", ["bin/elek-eval.mjs", "--suite", suitePath, "--json", summaryPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(output);
      expect(report.totals).toMatchObject({
        passed: true,
        expected: 1,
        matched: 1,
        findings: 2,
        falsePositives: 1,
      });
      expect(report.results[0]).toMatchObject({
        caseId: "auth-regression",
        precision: 0.5,
        recall: 1,
        costUsd: 0.0042,
        durationSeconds: 12.3,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when unmatched findings exceed the false-positive budget", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-eval-fail-test-"));
    try {
      const suitePath = join(dir, "suite.yml");
      const summaryPath = join(dir, "summary.json");
      writeFileSync(suitePath, `
version: 1
cases:
  - id: clean-refactor
    repository: acme/app
    number: 7
    expected_findings: []
    max_false_positives: 0
`);
      writeFileSync(summaryPath, JSON.stringify({
        version: 1,
        repository: "acme/app",
        run: { durationSeconds: 1 },
        entity: { number: 7 },
        review: { finalModel: "model", executedStrategy: "solo" },
        cost: { usd: 0 },
        findings: [{ title: "Speculative issue", severity: "minor", evidence: "maybe" }],
      }));

      expect(() => execFileSync("node", ["bin/elek-eval.mjs", "--suite", suitePath, summaryPath], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
