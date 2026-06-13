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
