import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

function writeSummary(dir: string) {
  const path = join(dir, "summary.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    generatedAt: "2026-06-14T10:00:00Z",
    repository: "acme/app",
    entity: { type: "pull_request", number: 42 },
    review: { executedStrategy: "solo", finalModel: "deepseek/deepseek-v4-pro" },
    findings: [
      {
        id: "tenant-bypass",
        title: "Tenant bypass",
        severity: "critical",
        confidence: "high",
        path: "src/auth.ts",
        line: "42",
      },
      {
        title: "Missing retry",
        severity: "minor",
        confidence: "medium",
        path: "src/queue.ts",
        line: "10",
      },
    ],
  }));
  return path;
}

describe("elek-feedback", () => {
  it("creates an editable feedback template from a review summary", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-feedback-template-test-"));
    try {
      const summaryPath = writeSummary(dir);
      const output = execFileSync("node", ["bin/elek-feedback.mjs", "--template", summaryPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const feedback = JSON.parse(output);

      expect(feedback).toMatchObject({
        version: 1,
        summary: {
          repository: "acme/app",
          entityType: "pull_request",
          number: 42,
          model: "deepseek/deepseek-v4-pro",
          strategy: "solo",
        },
        evaluator: "",
      });
      expect(feedback.findings).toEqual([
        expect.objectContaining({
          id: "tenant-bypass",
          title: "Tenant bypass",
          verdict: "unreviewed",
          points: 0,
        }),
        expect.objectContaining({
          id: "missing-retry",
          title: "Missing retry",
          verdict: "unreviewed",
          points: 0,
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies completed finding feedback to a review summary", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-feedback-apply-test-"));
    try {
      const summaryPath = writeSummary(dir);
      const feedbackPath = join(dir, "feedback.json");
      writeFileSync(feedbackPath, JSON.stringify({
        version: 1,
        evaluator: "implementation-agent",
        evaluatedAt: "2026-06-14T11:00:00Z",
        findings: [
          { id: "tenant-bypass", verdict: "accepted", points: 5, note: "real bug" },
          { id: "missing-retry", verdict: "partial", points: 3, note: "useful but low impact" },
        ],
      }));

      const output = execFileSync("node", [
        "bin/elek-feedback.mjs",
        "--apply",
        feedbackPath,
        summaryPath,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const summary = JSON.parse(output);

      expect(summary.findings).toEqual([
        expect.objectContaining({
          id: "tenant-bypass",
          feedback: {
            verdict: "accepted",
            points: 5,
            evaluator: "implementation-agent",
            evaluatedAt: "2026-06-14T11:00:00Z",
            note: "real bug",
          },
        }),
        expect.objectContaining({
          id: "missing-retry",
          feedback: expect.objectContaining({ verdict: "partial", points: 3 }),
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates generated feedback ids for repeated and colliding finding titles", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-feedback-id-test-"));
    try {
      const summaryPath = join(dir, "summary.json");
      writeFileSync(summaryPath, JSON.stringify({
        version: 1,
        findings: [
          { title: "Foo" },
          { title: "Foo" },
          { title: "Foo 1" },
          { title: "" },
        ],
      }));

      const output = execFileSync("node", ["bin/elek-feedback.mjs", "--template", summaryPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const feedback = JSON.parse(output);

      expect(feedback.findings.map((finding) => finding.id)).toEqual([
        "foo",
        "foo-1",
        "foo-1-1",
        "finding-4",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid feedback verdicts and scores", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-feedback-invalid-test-"));
    try {
      const summaryPath = writeSummary(dir);
      const invalidVerdict = join(dir, "invalid-verdict.json");
      writeFileSync(invalidVerdict, JSON.stringify({
        findings: [{ id: "tenant-bypass", verdict: "maybe", points: 1 }],
      }));
      expect(() => execFileSync("node", [
        "bin/elek-feedback.mjs",
        "--apply",
        invalidVerdict,
        summaryPath,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow("invalid verdict");

      const invalidScore = join(dir, "invalid-score.json");
      writeFileSync(invalidScore, JSON.stringify({
        findings: [{ id: "tenant-bypass", verdict: "accepted", points: 2.5 }],
      }));
      expect(() => execFileSync("node", [
        "bin/elek-feedback.mjs",
        "--apply",
        invalidScore,
        summaryPath,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow("points must be an integer between 0 and 5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when feedback references an unknown finding id", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-feedback-unmatched-test-"));
    try {
      const summaryPath = writeSummary(dir);
      const feedbackPath = join(dir, "feedback.json");
      writeFileSync(feedbackPath, JSON.stringify({
        findings: [
          { id: "tenant-bypass", verdict: "accepted", points: 5 },
          { id: "typo-id", verdict: "rejected", points: 0 },
        ],
      }));

      const result = spawnSync("node", [
        "bin/elek-feedback.mjs",
        "--apply",
        feedbackPath,
        summaryPath,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("typo-id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints feedback help", () => {
    const output = execFileSync("node", ["bin/elek-feedback.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(output).toContain("Usage: elek-feedback");
    expect(output).toContain("--template");
    expect(output).toContain("--apply");
  });
});
