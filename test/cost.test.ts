import { describe, expect, it } from "bun:test";
import {
  aggregateCosts,
  costFromPiResult,
  estimatePromptOnlyCost,
  estimateRunCost,
  estimateTokens,
  formatCostLine,
  formatTokenCount,
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

  it("reports invalid pricing override entries to the caller", () => {
    const invalid: string[] = [];
    parseCostRateOverrides("bad,=1:2,nope=a:2,neg=-1:2,missing=1:,extra=1:2:3", (entry, reason) => {
      invalid.push(`${entry}: ${reason}`);
    });

    expect(invalid).toEqual([
      "bad: missing model=price pair",
      "=1:2: empty model label",
      "nope=a:2: prices must be numeric input:output values",
      "neg=-1:2: prices must be zero or positive",
      "missing=1:: prices must include both input and output values",
      "extra=1:2:3: prices must be exactly input:output",
    ]);
  });

  it("prefers overrides over built-in price hints", () => {
    expect(resolveRates("deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro=1:2")).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 2,
      source: "override",
    });
  });

  it("has built-in price hints for recommended thermos models", () => {
    expect(resolveRates("together/moonshotai/Kimi-K2.7-Code", "")).toEqual({
      inputPerMillion: 0.95,
      outputPerMillion: 4,
      source: "builtin",
    });
    expect(resolveRates("together/deepseek-ai/DeepSeek-V4-Pro", "")).toEqual({
      inputPerMillion: 2.1,
      outputPerMillion: 4.4,
      source: "builtin",
    });
    expect(resolveRates("together/Qwen/Qwen3.7-Max", "")).toEqual({
      inputPerMillion: 1.25,
      outputPerMillion: 3.75,
      source: "builtin",
    });
    expect(resolveRates("openai/gpt-5.5", "")).toEqual({
      inputPerMillion: 5,
      outputPerMillion: 30,
      source: "builtin",
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

  it("estimates prompt-only cost for preflight budget checks", () => {
    const cost = estimatePromptOnlyCost({
      modelLabel: "deepseek/deepseek-v4-pro",
      prompt: "a".repeat(4000),
      costRates: "",
    });

    expect(cost.inputTokens).toBe(1000);
    expect(cost.outputTokens).toBe(0);
    expect(cost.costUsd).toBeCloseTo(0.000435, 8);
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

  it("aggregates empty cost lists to zero", () => {
    expect(aggregateCosts([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      estimated: false,
      runs: [],
    });
  });

  it("marks totals estimated when any run has unknown pricing", () => {
    const total = aggregateCosts([
      {
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0,
        estimated: true,
        modelLabel: "unknown/model",
        source: "unknown",
      },
    ]);

    expect(total.estimated).toBe(true);
  });

  it("formats unknown pricing as unknown instead of implying a free review", () => {
    const total = aggregateCosts([
      {
        inputTokens: 43720,
        outputTokens: 0,
        costUsd: 0,
        estimated: true,
        modelLabel: "custom/frontier-model",
        source: "unknown",
      },
    ]);

    expect(formatCostLine(total)).toBe(
      "Estimated review cost: unknown (43,720 in / 0 out tokens; missing price data for custom/frontier-model)",
    );
  });

  it("formats partial cost totals when some model prices are unknown", () => {
    const total = aggregateCosts([
      {
        inputTokens: 1000,
        outputTokens: 250,
        costUsd: 0.01,
        estimated: true,
        modelLabel: "known/model",
        source: "builtin",
      },
      {
        inputTokens: 500,
        outputTokens: 50,
        costUsd: 0,
        estimated: true,
        modelLabel: "unknown/model",
        source: "unknown",
      },
    ]);

    expect(formatCostLine(total)).toBe(
      "Estimated review cost: at least $0.0100 (1,500 in / 300 out tokens; missing price data for unknown/model)",
    );
  });

  it("preserves pricing source from pi results", () => {
    const cost = costFromPiResult({
      conclusion: "success",
      output: "ok",
      turnsUsed: 1,
      providerRetries: 0,
      durationSeconds: 1,
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
    expect(formatUsd(0.0001)).toBe("$0.0001");
    expect(formatUsd(-0.01)).toBe("$0.0000");
  });

  it("formats token counts for readable comment output", () => {
    expect(formatTokenCount(1234567)).toBe("1,234,567");
  });

  it("uses a non-estimated cost label when exact usage is available", () => {
    expect(formatCostLine({
      inputTokens: 1000,
      outputTokens: 250,
      costUsd: 0.01,
      estimated: false,
      runs: [],
    })).toBe("Review cost: $0.0100 (1,000 in / 250 out tokens)");
  });
});
