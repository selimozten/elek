import { describe, expect, it } from "bun:test";
import { aggregateCosts } from "../src/review/cost";
import { buildReviewSummary, metricFromPiRun } from "../src/review/summary";
import type { GitHubEntityContext, PiRunResult } from "../src/types";

const context: GitHubEntityContext = {
  eventName: "pull_request",
  eventAction: "synchronize",
  actor: "alice",
  repo: {
    owner: "acme",
    repo: "app",
    fullName: "acme/app",
    defaultBranch: "main",
  },
  entityNumber: 42,
  isPR: true,
  triggerText: "@pi review",
  pr: {
    title: "Fix billing bug",
    body: "Body",
    headRef: "feature/billing",
    baseRef: "main",
    headSha: "abc",
    baseSha: "def",
  },
};

function piResult(overrides: Partial<PiRunResult> = {}): PiRunResult {
  return {
    conclusion: "success",
    output: "ok",
    turnsUsed: 2,
    durationSeconds: 12.34,
    costUsd: 0.00123456,
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      estimated: true,
      modelLabel: "deepseek/deepseek-v4-pro",
      source: "builtin",
    },
    ...overrides,
  };
}

describe("review summary", () => {
  it("builds machine-readable review metrics", () => {
    const reviewer = piResult({
      usage: {
        inputTokens: 500,
        outputTokens: 100,
        estimated: true,
        modelLabel: "openrouter/moonshotai/kimi-k2.7-code",
        source: "override",
      },
      costUsd: 0.004,
      durationSeconds: 65.66,
    });
    const validator = piResult();
    const costTotal = aggregateCosts([
      {
        inputTokens: reviewer.usage.inputTokens,
        outputTokens: reviewer.usage.outputTokens,
        costUsd: reviewer.costUsd,
        estimated: reviewer.usage.estimated,
        modelLabel: reviewer.usage.modelLabel,
        source: reviewer.usage.source,
      },
      {
        inputTokens: validator.usage.inputTokens,
        outputTokens: validator.usage.outputTokens,
        costUsd: validator.costUsd,
        estimated: validator.usage.estimated,
        modelLabel: validator.usage.modelLabel,
        source: validator.usage.source,
      },
    ]);

    const summary = buildReviewSummary({
      context,
      runId: "123",
      jobRunLink: "https://github.com/acme/app/actions/runs/123",
      conclusion: "success",
      mode: "review",
      requestedStrategy: "crosscheck",
      executedStrategy: "crosscheck",
      primaryModelLabel: "deepseek/deepseek-v4-pro",
      finalModelLabel: "deepseek/deepseek-v4-pro",
      startedAt: new Date("2026-06-13T10:00:00Z"),
      finishedAt: new Date("2026-06-13T10:02:03.450Z"),
      commentId: 99,
      branchName: "elek/fix",
      inlineComments: { posted: 2, skipped: 1, failed: 0 },
      costTotal,
      runs: [
        metricFromPiRun(reviewer, "reviewer", { lensId: "correctness", lensTitle: "Correctness" }),
        metricFromPiRun(validator, "validator"),
      ],
    });

    expect(summary.run.durationSeconds).toBe(123.5);
    expect(summary.entity).toMatchObject({
      type: "pull_request",
      number: 42,
      title: "Fix billing bug",
    });
    expect(summary.review).toMatchObject({
      requestedStrategy: "crosscheck",
      executedStrategy: "crosscheck",
      commentId: "99",
    });
    expect(summary.inlineComments).toEqual({ posted: 2, skipped: 1, failed: 0 });
    expect(summary.cost).toMatchObject({
      usd: 0.005235,
      inputTokens: 1500,
      outputTokens: 300,
      estimated: true,
    });
    expect(summary.modelRuns[0]).toMatchObject({
      role: "reviewer",
      lensId: "correctness",
      durationSeconds: 65.7,
      pricingSource: "override",
    });
    expect(JSON.parse(JSON.stringify(summary)).version).toBe(1);
  });

  it("handles issue reviews and missing optional fields", () => {
    const issueContext: GitHubEntityContext = {
      ...context,
      eventName: "issues",
      eventAction: "opened",
      isPR: false,
      pr: undefined,
      issue: {
        title: "Investigate queue drift",
        body: "Body",
        labels: ["bug"],
        assignees: [],
      },
    };

    const failed = piResult({
      conclusion: "failure",
      costUsd: 0,
      durationSeconds: 0.04,
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        estimated: true,
        modelLabel: "unknown/model",
        source: "unknown",
      },
    });
    const summary = buildReviewSummary({
      context: issueContext,
      runId: "124",
      jobRunLink: "https://github.com/acme/app/actions/runs/124",
      conclusion: "failure",
      mode: "review",
      requestedStrategy: "",
      executedStrategy: "solo",
      primaryModelLabel: "unknown/model",
      finalModelLabel: "unknown/model",
      startedAt: new Date("2026-06-13T10:00:00Z"),
      finishedAt: new Date("2026-06-13T10:00:00.040Z"),
      inlineComments: { posted: 0, skipped: 0, failed: 0 },
      costTotal: aggregateCosts([{
        inputTokens: failed.usage.inputTokens,
        outputTokens: failed.usage.outputTokens,
        costUsd: failed.costUsd,
        estimated: failed.usage.estimated,
        modelLabel: failed.usage.modelLabel,
        source: failed.usage.source,
      }]),
      runs: [metricFromPiRun(failed, "validator")],
    });

    expect(summary.run).toMatchObject({ conclusion: "failure", durationSeconds: 0 });
    expect(summary.entity).toMatchObject({
      type: "issue",
      number: 42,
      title: "Investigate queue drift",
      event: "issues",
    });
    expect(summary.review).toMatchObject({
      requestedStrategy: "solo",
      executedStrategy: "solo",
      branchName: "",
      commentId: "",
    });
    expect(summary.cost).toMatchObject({
      usd: 0,
      inputTokens: 1,
      outputTokens: 0,
      estimated: true,
    });
    expect(summary.modelRuns).toHaveLength(1);
    expect(summary.modelRuns[0]).toMatchObject({
      role: "validator",
      conclusion: "failure",
      pricingSource: "unknown",
    });
  });

  it("records solo reviews as one validator run", () => {
    const validator = piResult({
      durationSeconds: 4.44,
      costUsd: 0.00012,
      usage: {
        inputTokens: 300,
        outputTokens: 40,
        estimated: true,
        modelLabel: "deepseek/deepseek-v4-pro",
        source: "builtin",
      },
    });
    const summary = buildReviewSummary({
      context,
      runId: "125",
      jobRunLink: "https://github.com/acme/app/actions/runs/125",
      conclusion: "success",
      mode: "review",
      requestedStrategy: "",
      executedStrategy: "solo",
      primaryModelLabel: "deepseek/deepseek-v4-pro",
      finalModelLabel: "deepseek/deepseek-v4-pro",
      startedAt: new Date("2026-06-13T10:00:00Z"),
      finishedAt: new Date("2026-06-13T10:00:04.440Z"),
      commentId: 123,
      inlineComments: { posted: 1, skipped: 0, failed: 0 },
      costTotal: aggregateCosts([{
        inputTokens: validator.usage.inputTokens,
        outputTokens: validator.usage.outputTokens,
        costUsd: validator.costUsd,
        estimated: validator.usage.estimated,
        modelLabel: validator.usage.modelLabel,
        source: validator.usage.source,
      }]),
      runs: [metricFromPiRun(validator, "validator")],
    });

    expect(summary.review.executedStrategy).toBe("solo");
    expect(summary.cost.runs).toHaveLength(1);
    expect(summary.modelRuns).toHaveLength(1);
    expect(summary.modelRuns[0]).toMatchObject({
      role: "validator",
      modelLabel: "deepseek/deepseek-v4-pro",
      durationSeconds: 4.4,
      inputTokens: 300,
      outputTokens: 40,
    });
    expect(summary.cost.usd).toBe(0.00012);
  });

  it("clamps and rounds duration and cost boundary values", () => {
    const first = piResult({ durationSeconds: -1, costUsd: -1 });
    const second = piResult({ durationSeconds: 0.05, costUsd: 0.0000005 });
    const summary = buildReviewSummary({
      context,
      runId: "126",
      jobRunLink: "https://github.com/acme/app/actions/runs/126",
      conclusion: "success",
      mode: "review",
      requestedStrategy: "",
      executedStrategy: "solo",
      primaryModelLabel: "deepseek/deepseek-v4-pro",
      finalModelLabel: "deepseek/deepseek-v4-pro",
      startedAt: new Date("2026-06-13T10:00:00Z"),
      finishedAt: new Date("2026-06-13T10:00:00.050Z"),
      inlineComments: { posted: 0, skipped: 0, failed: 0 },
      costTotal: aggregateCosts([{
        inputTokens: first.usage.inputTokens,
        outputTokens: first.usage.outputTokens,
        costUsd: first.costUsd,
        estimated: first.usage.estimated,
        modelLabel: first.usage.modelLabel,
        source: first.usage.source,
      }, {
        inputTokens: second.usage.inputTokens,
        outputTokens: second.usage.outputTokens,
        costUsd: second.costUsd,
        estimated: second.usage.estimated,
        modelLabel: second.usage.modelLabel,
        source: second.usage.source,
      }]),
      runs: [
        metricFromPiRun(first, "reviewer"),
        metricFromPiRun(second, "validator"),
      ],
    });

    expect(summary.run.durationSeconds).toBe(0.1);
    expect(summary.cost.usd).toBe(0);
    expect(summary.modelRuns[0].durationSeconds).toBe(0);
    expect(summary.modelRuns[0].costUsd).toBe(0);
    expect(summary.modelRuns[1].durationSeconds).toBe(0.1);
    expect(summary.modelRuns[1].costUsd).toBe(0.000001);
  });
});
