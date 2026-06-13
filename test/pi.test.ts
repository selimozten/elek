import { describe, expect, it } from "bun:test";
import { buildPiArgs } from "../src/pi";
import type { ActionInputs } from "../src/types";

const baseInputs: ActionInputs = {
  triggerPhrase: "@pi",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  thinking: "medium",
  prompt: "",
  systemPrompt: "",
  maxTurns: 20,
  tools: "read,grep,find,ls",
  branchPrefix: "elek/",
  actorFilter: "",
  allowedBots: "",
  stickyComment: true,
  mode: "review",
  reviewStrategy: "solo",
  reviewModels: "",
  validatorModel: "",
};

describe("buildPiArgs", () => {
  it("omits --model when the provider default model is requested", () => {
    const args = buildPiArgs({ ...baseInputs, model: "" }, "/tmp/prompt.md", false);

    expect(args).toContain("--provider");
    expect(args).toContain("deepseek");
    expect(args).not.toContain("--model");
    expect(args).toContain("--no-extensions");
  });

  it("lets provider-qualified model specs route themselves", () => {
    const args = buildPiArgs(
      { ...baseInputs, provider: "zai", model: "zai/glm-5.1" },
      "/tmp/prompt.md",
      true,
    );

    expect(args).not.toContain("--provider");
    expect(args).toContain("--model");
    expect(args).toContain("zai/glm-5.1");
    expect(args).not.toContain("--no-extensions");
  });
});
