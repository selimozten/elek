import { describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

describe("elek-benchmark", () => {
  it("creates an editable benchmark suite from a review summary", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-benchmark-test-"));
    try {
      const summaryPath = join(dir, "summary.json");
      writeFileSync(summaryPath, JSON.stringify({
        version: 1,
        repository: "acme/app",
        entity: { number: 42 },
        findings: [{
          title: "Tenant session bypass",
          severity: "critical",
          path: "src/auth.ts",
          evidence: "tenant is accepted from the request while session tenant is ignored",
          impact: "tenant isolation can be bypassed",
          fix: "compare the request tenant with the session tenant",
        }],
      }));

      const output = execFileSync("node", [
        "bin/elek-benchmark.mjs",
        "--id",
        "auth-regression",
        "--max-false-positives",
        "1",
        summaryPath,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(output.endsWith("\n")).toBe(true);
      const suite = parseYaml(output);

      expect(suite).toEqual({
        version: 1,
        cases: [{
          id: "auth-regression",
          repository: "acme/app",
          number: 42,
          expected_findings: [{
            id: "tenant-session-bypass",
            min_severity: "critical",
            keywords: ["tenant", "session", "bypass"],
          }],
          max_false_positives: 1,
        }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a clean benchmark case when requested", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-benchmark-clean-test-"));
    try {
      const summaryPath = join(dir, "summary.json");
      writeFileSync(summaryPath, JSON.stringify({
        version: 1,
        repository: "acme/app",
        entity: { number: 7 },
        findings: [{ title: "Ignored finding", severity: "important" }],
      }));

      const output = execFileSync("node", ["bin/elek-benchmark.mjs", "--clean", summaryPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const suite = parseYaml(output);

      expect(suite.cases[0]).toMatchObject({
        id: "acme-app-7",
        repository: "acme/app",
        number: 7,
        expected_findings: [],
        max_false_positives: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits severity floors that would not match the source summary", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-benchmark-severity-test-"));
    try {
      const summaryPath = join(dir, "summary.json");
      writeFileSync(summaryPath, JSON.stringify({
        version: 1,
        repository: "acme/app",
        entity: { number: "9" },
        review: {
          findings: [{
            title: "Unranked issue",
            severity: "advisory",
            evidence: "x y",
          }],
        },
      }));

      const output = execFileSync("node", ["bin/elek-benchmark.mjs", summaryPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const suite = parseYaml(output);

      expect(suite.cases[0].expected_findings[0]).toEqual({
        id: "unranked-issue",
        keywords: ["unranked", "issue"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects summaries with invalid entity numbers", () => {
    const invalidNumbers = ["42abc", " ", true];
    for (const number of invalidNumbers) {
      const dir = mkdtempSync(join(process.cwd(), ".elek-benchmark-number-test-"));
      try {
        const summaryPath = join(dir, "summary.json");
        writeFileSync(summaryPath, JSON.stringify({
          version: 1,
          repository: "acme/app",
          entity: { number },
          findings: [],
        }));

        expect(() => execFileSync("node", ["bin/elek-benchmark.mjs", summaryPath], {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        })).toThrow("summary.entity.number must be a non-negative integer");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("falls back to a placeholder keyword when finding text has no useful words", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-benchmark-keyword-test-"));
    try {
      const summaryPath = join(dir, "summary.json");
      writeFileSync(summaryPath, JSON.stringify({
        version: 1,
        repository: "acme/app",
        entity: { number: 10 },
        findings: [{ title: "!!!", severity: "minor" }],
      }));

      const output = execFileSync("node", ["bin/elek-benchmark.mjs", summaryPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const suite = parseYaml(output);

      expect(suite.cases[0].expected_findings[0]).toEqual({
        id: "finding-1",
        min_severity: "minor",
        keywords: ["replace-me"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates generated expected finding ids", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-benchmark-id-test-"));
    try {
      const summaryPath = join(dir, "summary.json");
      writeFileSync(summaryPath, JSON.stringify({
        version: 1,
        repository: "acme/app",
        entity: { number: 11 },
        findings: [
          { title: "Issue", severity: "minor" },
          { title: "Issue", severity: "minor" },
          { title: "Issue 2", severity: "minor" },
        ],
      }));

      const output = execFileSync("node", ["bin/elek-benchmark.mjs", summaryPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const suite = parseYaml(output);

      expect(suite.cases[0].expected_findings.map((finding) => finding.id)).toEqual([
        "issue",
        "issue-1",
        "issue-2",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports invalid benchmark generator options clearly", () => {
    expect(() => execFileSync("node", [
      "bin/elek-benchmark.mjs",
      "--max-false-positives",
      "1.5",
      "summary.json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow("--max-false-positives requires a non-negative integer");

    expect(() => execFileSync("node", [
      "bin/elek-benchmark.mjs",
      "--id",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow("--id requires a case id");
  });
});
