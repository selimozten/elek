import { describe, expect, it } from "bun:test";
import { estimateTokens, formatTokenLine, modelLabelFor } from "../src/review/usage";

describe("review usage", () => {
  it("labels the model with its provider once", () => {
    expect(modelLabelFor({ provider: "deepseek", model: "" })).toBe("deepseek");
    expect(modelLabelFor({ provider: "deepseek", model: "deepseek-v4-pro" })).toBe("deepseek/deepseek-v4-pro");
    expect(modelLabelFor({ provider: "openrouter", model: "openrouter/moonshotai/kimi" })).toBe("openrouter/moonshotai/kimi");
    expect(modelLabelFor({ provider: "together", model: "together" })).toBe("together");
  });

  it("estimates tokens at four characters each", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("x".repeat(401))).toBe(101);
  });

  it("formats reported and estimated token counts", () => {
    expect(formatTokenLine({ inputTokens: 12345, outputTokens: 678, estimated: false }))
      .toBe("Token usage: 12,345 in / 678 out");
    expect(formatTokenLine({ inputTokens: 100, outputTokens: 0, estimated: true }))
      .toBe("Estimated token usage: 100 in / 0 out");
  });
});
