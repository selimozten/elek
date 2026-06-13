import { describe, expect, it } from "bun:test";
import {
  aggregateCosts,
  costFromPiResult,
  estimateRunCost,
  estimateTokens,
  formatCostLine,
  formatUsd,
  modelLabelFor,
  parseCostRateOverrides,
  resolveRates,
} from "../src/review/cost";

describe("review cost estimates", () => {
  it("estimates tokens from text length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("does not double-prefix provider-qualified model labels", () => {
    expect(modelLabelFor({ provider: "openrouter", model: "openrouter/moonshotai/kimi-k2.7-code" }))
      .toBe("openrouter/moonshotai/kimi-k2.7-code");
    expect(modelLabelFor({ provider: "deepseek", model: "deepseek-v4-pro" }))
      .toBe("deepseek/deepseek-v4-pro");
  });

  it("parses pricing overrides as dollars per million tokens", () => {
    expect(parseCostRateOverrides("openai/gpt-5.5=1.25:10,bad,deepseek/x=0.1:0.2,nope=-1:2")).toEqual({
      "openai/gpt-5.5": { inputPerMillion: 1.25, outputPerMillion: 10 },
      "deepseek/x": { inputPerMillion: 0.1, outputPerMillion: 0.2 },
    });
  });

  it("prefers overrides over built-in price hints", () => {
    expect(resolveRates("deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro=1:2")).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 2,
      source: "override",
    });
  });

  it("estimates a run cost from prompt and output text", () => {
    const cost = estimateRunCost({
      modelLabel: "deepseek/deepseek-v4-pro",
      prompt: "a".repeat(4000),
      output: "b".repeat(4000),
      costRates: "",
    });

    expect(cost.inputTokens).toBe(1000);
    expect(cost.outputTokens).toBe(1000);
    expect(cost.costUsd).toBeCloseTo(0.000435 + 0.00087, 8);
    expect(cost.source).toBe("builtin");
  });

  it("aggregates multi-run review cost", () => {
    const total = aggregateCosts([
      {
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
        estimated: true,
        modelLabel: "a",
        source: "builtin",
      },
      {
        inputTokens: 20,
        outputTokens: 7,
        costUsd: 0.002,
        estimated: true,
        modelLabel: "b",
        source: "override",
      },
    ]);

    expect(total.inputTokens).toBe(30);
    expect(total.outputTokens).toBe(12);
    expect(total.costUsd).toBeCloseTo(0.003, 8);
    expect(formatCostLine(total)).toContain("Estimated review cost: $0.0030");
  });

  it("preserves pricing source from pi results", () => {
    const cost = costFromPiResult({
      conclusion: "success",
      output: "ok",
      turnsUsed: 1,
      costUsd: 0.01,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        estimated: true,
        modelLabel: "custom/model",
        source: "override",
      },
    });

    expect(cost.source).toBe("override");
  });

  it("formats tiny costs without rounding up to a misleading cent value", () => {
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(0.00001)).toBe("<$0.0001");
  });
});
