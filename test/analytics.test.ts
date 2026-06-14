import { describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

function writeSummary(dir: string, name: string, overrides: Record<string, unknown> = {}) {
  const summary = {
    version: 1,
    repository: "acme/app",
    run: { conclusion: "success", durationSeconds: 10 },
    entity: { type: "pull_request", number: 1 },
    review: { executedStrategy: "solo", finalModel: "deepseek/deepseek-v4-pro" },
    inlineComments: { posted: 1, skipped: 0, failed: 0 },
    findings: [{ title: "Issue" }],
    cost: { usd: 0.001, inputTokens: 1000, outputTokens: 100 },
    ...overrides,
  };
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(summary));
  return path;
}

describe("elek-analytics", () => {
  it("aggregates saved review summaries by strategy as JSON", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-test-"));
    try {
      const solo = writeSummary(dir, "solo.json");
      const crosscheck = writeSummary(dir, "crosscheck.json", {
        run: { conclusion: "failure", durationSeconds: 20 },
        review: { executedStrategy: "crosscheck", finalModel: "openrouter/moonshotai/kimi-k2.7-code" },
        inlineComments: { posted: 2, skipped: 1, failed: 1 },
        findings: [{ title: "A" }, { title: "B" }],
        cost: { usd: 0.004, inputTokens: 2000, outputTokens: 500 },
      });
      const output = execFileSync("node", [
        "bin/elek-analytics.mjs",
        "--json",
        solo,
        crosscheck,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      const report = JSON.parse(output);
      expect(report.groupBy).toBe("strategy");
      expect(report.totals).toMatchObject({
        runs: 2,
        successes: 1,
        failures: 1,
        successRate: 0.5,
        findings: 3,
        findingsPerRun: 1.5,
        inlinePosted: 3,
        inlineSkipped: 1,
        inlineFailed: 1,
        costUsd: 0.005,
        avgCostUsd: 0.0025,
        inputTokens: 3000,
        outputTokens: 600,
        durationSeconds: 30,
        avgDurationSeconds: 15,
      });
      expect(report.groups).toEqual([
        expect.objectContaining({
          key: "crosscheck",
          runs: 1,
          failures: 1,
          findings: 2,
          costUsd: 0.004,
        }),
        expect.objectContaining({
          key: "solo",
          runs: 1,
          successes: 1,
          findings: 1,
          costUsd: 0.001,
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("groups saved summaries by final model", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-model-test-"));
    try {
      const first = writeSummary(dir, "first.json");
      const second = writeSummary(dir, "second.json", {
        review: { executedStrategy: "crosscheck", finalModel: "openrouter/moonshotai/kimi-k2.7-code" },
        cost: { usd: 0.002, inputTokens: 500, outputTokens: 50 },
      });

      const output = execFileSync("node", [
        "bin/elek-analytics.mjs",
        "--group-by",
        "model",
        "--json",
        first,
        second,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(output);

      expect(report.groupBy).toBe("model");
      expect(report.groups.map((group) => group.key)).toEqual([
        "deepseek/deepseek-v4-pro",
        "openrouter/moonshotai/kimi-k2.7-code",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("groups saved summaries by repository", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-repo-test-"));
    try {
      const first = writeSummary(dir, "first.json");
      const second = writeSummary(dir, "second.json", {
        repository: "othercorp/lib",
      });

      const output = execFileSync("node", [
        "bin/elek-analytics.mjs",
        "--group-by",
        "repository",
        "--json",
        first,
        second,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(output);

      expect(report.groupBy).toBe("repository");
      expect(report.groups.map((group) => group.key)).toEqual(["acme/app", "othercorp/lib"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregates multiple summaries into the same group", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-same-group-test-"));
    try {
      const first = writeSummary(dir, "first.json", {
        cost: { usd: 0.002, inputTokens: 1000, outputTokens: 100 },
      });
      const second = writeSummary(dir, "second.json", {
        run: { conclusion: "success", durationSeconds: 30 },
        inlineComments: { posted: 3, skipped: 1, failed: 0 },
        findings: [{ title: "A" }, { title: "B" }],
        cost: { usd: 0.004, inputTokens: 3000, outputTokens: 300 },
      });

      const output = execFileSync("node", [
        "bin/elek-analytics.mjs",
        "--json",
        first,
        second,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(output);

      expect(report.groups).toEqual([
        expect.objectContaining({
          key: "solo",
          runs: 2,
          successes: 2,
          findings: 3,
          findingsPerRun: 1.5,
          inlinePosted: 4,
          inlineSkipped: 1,
          inlineFailed: 0,
          costUsd: 0.006,
          avgCostUsd: 0.003,
          inputTokens: 4000,
          outputTokens: 400,
          durationSeconds: 40,
          avgDurationSeconds: 20,
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregates finding feedback for model quality analytics", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-feedback-test-"));
    try {
      const deepseek = writeSummary(dir, "deepseek.json", {
        findings: [
          { title: "Accepted", feedback: { verdict: "accepted", points: 5 } },
          { title: "Rejected", feedback: { verdict: "rejected", points: 0 } },
          { title: "Typo verdict", feedback: { verdict: "accepeted", points: 5 } },
          { title: "Invalid score", feedback: { verdict: "accepted", points: -1 } },
        ],
      });
      const kimi = writeSummary(dir, "kimi.json", {
        review: { executedStrategy: "crosscheck", finalModel: "openrouter/moonshotai/kimi-k2.7-code" },
        findings: [
          { title: "Useful but incomplete", feedback: { verdict: "partial", points: 3 } },
          { title: "Not adjudicated", feedback: { verdict: "unreviewed", points: 0 } },
        ],
      });

      const output = execFileSync("node", [
        "bin/elek-analytics.mjs",
        "--group-by",
        "model",
        "--json",
        deepseek,
        kimi,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(output);

      expect(report.groups).toEqual([
        expect.objectContaining({
          key: "deepseek/deepseek-v4-pro",
          findings: 4,
          reviewedFindings: 2,
          acceptedFindings: 1,
          partialFindings: 0,
          rejectedFindings: 1,
          acceptanceRate: 0.5,
          feedbackPoints: 5,
          avgFindingScore: 2.5,
        }),
        expect.objectContaining({
          key: "openrouter/moonshotai/kimi-k2.7-code",
          findings: 2,
          reviewedFindings: 1,
          acceptedFindings: 0,
          partialFindings: 1,
          rejectedFindings: 0,
          acceptanceRate: 1,
          feedbackPoints: 3,
          avgFindingScore: 3,
        }),
      ]);
      expect(report.totals).toMatchObject({
        reviewedFindings: 3,
        acceptedFindings: 1,
        partialFindings: 1,
        rejectedFindings: 1,
        acceptanceRate: 0.667,
        feedbackPoints: 8,
        avgFindingScore: 2.667,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles partial summaries gracefully", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-partial-test-"));
    try {
      const partial = join(dir, "partial.json");
      writeFileSync(partial, JSON.stringify({
        version: 1,
        run: { conclusion: "skipped" },
      }));

      const output = execFileSync("node", ["bin/elek-analytics.mjs", "--json", partial], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(output);

      expect(report.groups[0]).toMatchObject({
        key: "(unknown)",
        runs: 1,
        successes: 0,
        failures: 1,
        findings: 0,
        costUsd: 0,
      });
      expect(report.totals).toMatchObject({
        runs: 1,
        successes: 0,
        failures: 1,
        costUsd: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a readable analytics table", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-table-test-"));
    try {
      const summary = writeSummary(dir, "summary.json");
      const output = execFileSync("node", ["bin/elek-analytics.mjs", summary], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(output).toContain("group");
      expect(output).toContain("avg cost");
      expect(output).toContain("posted/skip/fail");
      expect(output).toContain("solo");
      expect(output).toContain("total");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compares baseline and current summaries for trend regressions", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-trend-test-"));
    try {
      const baseline = writeSummary(dir, "baseline.json", {
        run: { conclusion: "success", durationSeconds: 10 },
        inlineComments: { posted: 10, skipped: 0, failed: 0 },
        findings: [{ title: "A" }],
        cost: { usd: 0.001, inputTokens: 1000, outputTokens: 100 },
      });
      const current = writeSummary(dir, "current.json", {
        run: { conclusion: "failure", durationSeconds: 30 },
        inlineComments: { posted: 8, skipped: 2, failed: 2 },
        findings: [{ title: "A" }, { title: "B" }, { title: "C" }],
        cost: { usd: 0.004, inputTokens: 3000, outputTokens: 400 },
      });

      const output = execFileSync("node", [
        "bin/elek-analytics.mjs",
        "--json",
        "--baseline",
        baseline,
        "--current",
        current,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(output);

      expect(report.groupBy).toBe("strategy");
      expect(report.comparisons).toEqual([
        expect.objectContaining({
          key: "solo",
          delta: expect.objectContaining({
            successRate: -1,
            findingsPerRun: 2,
            inlineIssueRate: 0.333,
            avgCostUsd: 0.003,
            avgDurationSeconds: 20,
          }),
          regressions: [
            "success rate down 100 pts",
            "inline issue rate up 33 pts",
            "average latency up 20s",
            "average cost up $0.003000",
          ],
          changes: ["finding volume up 2/run"],
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a readable trend comparison table", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-trend-table-test-"));
    try {
      const baseline = writeSummary(dir, "baseline.json");
      const current = writeSummary(dir, "current.json", {
        cost: { usd: 0.002, inputTokens: 2000, outputTokens: 200 },
      });

      const output = execFileSync("node", [
        "bin/elek-analytics.mjs",
        "--baseline",
        baseline,
        "--current",
        current,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(output).toContain("findings/run");
      expect(output).toContain("accept+partial");
      expect(output).toContain("score");
      expect(output).toContain("inline issues");
      expect(output).toContain("changes");
      expect(output).toContain("$0.002000 (+$0.001000)");
      expect(output).toContain("solo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compares asymmetric trend groups without marking new groups as regressions", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-asymmetric-trend-test-"));
    try {
      const baseline = writeSummary(dir, "baseline.json");
      const current = writeSummary(dir, "current.json", {
        review: { executedStrategy: "crosscheck", finalModel: "openrouter/moonshotai/kimi-k2.7-code" },
        cost: { usd: 0.004, inputTokens: 3000, outputTokens: 400 },
        run: { conclusion: "success", durationSeconds: 30 },
      });

      const output = execFileSync("node", [
        "bin/elek-analytics.mjs",
        "--json",
        "--baseline",
        baseline,
        "--current",
        current,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(output);

      expect(report.comparisons).toEqual([
        expect.objectContaining({
          key: "crosscheck",
          baseline: expect.objectContaining({ runs: 0, avgCostUsd: 0, avgDurationSeconds: 0 }),
          current: expect.objectContaining({ runs: 1, avgCostUsd: 0.004, avgDurationSeconds: 30 }),
          regressions: [],
          changes: [],
        }),
        expect.objectContaining({
          key: "solo",
          baseline: expect.objectContaining({ runs: 1, avgCostUsd: 0.001, avgDurationSeconds: 10 }),
          current: expect.objectContaining({ runs: 0, avgCostUsd: 0, avgDurationSeconds: 0 }),
          regressions: [],
          changes: [],
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("triggers trend regressions at exact threshold boundaries", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-boundary-trend-test-"));
    try {
      const baseline = [];
      const current = [];
      for (let index = 0; index < 20; index++) {
        baseline.push(writeSummary(dir, `baseline-${index}.json`, {
          run: { conclusion: "success", durationSeconds: 25 },
          inlineComments: { posted: 1, skipped: 0, failed: 0 },
          findings: [{ title: "A", feedback: { verdict: "accepted", points: 5 } }],
          cost: { usd: 0.005, inputTokens: 1000, outputTokens: 100 },
        }));
        current.push(writeSummary(dir, `current-${index}.json`, {
          run: { conclusion: index === 0 ? "failure" : "success", durationSeconds: 30 },
          inlineComments: index === 0
            ? { posted: 0, skipped: 1, failed: 0 }
            : { posted: 1, skipped: 0, failed: 0 },
          findings: [{
            title: "A",
            feedback: index === 0
              ? { verdict: "rejected", points: 0 }
              : index === 1
                ? { verdict: "partial", points: 0 }
                : { verdict: "accepted", points: 5 },
          }],
          cost: { usd: 0.006, inputTokens: 1200, outputTokens: 120 },
        }));
      }

      const output = execFileSync("node", [
        "bin/elek-analytics.mjs",
        "--json",
        "--baseline",
        ...baseline,
        "--current",
        ...current,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const report = JSON.parse(output);

      expect(report.comparisons[0].delta).toMatchObject({
        successRate: -0.05,
        inlineIssueRate: 0.05,
        acceptanceRate: -0.05,
        avgFindingScore: -0.5,
        avgCostUsd: 0.001,
        avgDurationSeconds: 5,
      });
      expect(report.comparisons[0].regressions).toEqual([
        "success rate down 5 pts",
        "inline issue rate up 5 pts",
        "finding acceptance down 5 pts",
        "average finding score down 0.5",
        "average latency up 5s",
        "average cost up $0.001000",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports analytics usage errors clearly", () => {
    expect(() => execFileSync("node", ["bin/elek-analytics.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow("at least one summary JSON path is required");

    expect(() => execFileSync("node", [
      "bin/elek-analytics.mjs",
      "--group-by",
      "provider",
      "summary.json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow("--group-by must be one of: strategy, model, repository");

    expect(() => execFileSync("node", [
      "bin/elek-analytics.mjs",
      "--baseline",
      "old.json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow("--baseline and --current both require at least one summary path");

    expect(() => execFileSync("node", [
      "bin/elek-analytics.mjs",
      "summary.json",
      "--baseline",
      "old.json",
      "--current",
      "new.json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow("do not mix positional summaries with --baseline/--current");
  });

  it("reports the file path when a summary cannot be parsed", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-analytics-invalid-test-"));
    try {
      const invalid = join(dir, "invalid.json");
      writeFileSync(invalid, "{");

      expect(() => execFileSync("node", ["bin/elek-analytics.mjs", invalid], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow(`failed to read summary ${invalid}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints analytics help", () => {
    const output = execFileSync("node", ["bin/elek-analytics.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(output).toContain("Usage: elek-analytics");
    expect(output).toContain("--group-by");
  });
});
