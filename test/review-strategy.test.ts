import { describe, expect, it } from "bun:test";
import {
  parseModelList,
  parseModelSpec,
  resolveReviewPlan,
  resolveReviewStrategy,
} from "../src/review/strategy";
import type { ActionInputs } from "../src/types";

const baseInputs: ActionInputs = {
  triggerPhrase: "@pi",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  thinking: "medium",
  prompt: "",
  systemPrompt: "",
  maxTurns: 20,
  tools: "",
  branchPrefix: "elek/",
  actorFilter: "",
  allowedBots: "",
  stickyComment: true,
  mode: "review",
  reviewStrategy: "solo",
  reviewModels: "",
  validatorModel: "",
};

describe("review strategy", () => {
  it("keeps solo as the safe default", () => {
    expect(resolveReviewStrategy(undefined)).toBe("solo");
    expect(resolveReviewStrategy("nonsense")).toBe("solo");
  });

  it("accepts useful aliases without exposing the internal naming", () => {
    expect(resolveReviewStrategy("dual")).toBe("crosscheck");
    expect(resolveReviewStrategy("swarm")).toBe("council");
  });

  it("parses provider-qualified model specs as self-routing pi models", () => {
    const spec = parseModelSpec("zai/glm-5.1", baseInputs);
    expect(spec).toEqual({
      provider: "zai",
      model: "zai/glm-5.1",
      label: "zai/glm-5.1",
    });
  });

  it("parses unqualified model specs against the primary provider", () => {
    expect(parseModelSpec("deepseek-v4-flash", baseInputs)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      label: "deepseek/deepseek-v4-flash",
    });
  });

  it("builds a crosscheck plan with two named lenses", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "crosscheck",
      reviewModels: "deepseek/deepseek-v4-pro,zai/glm-5.1",
      validatorModel: "deepseek/deepseek-v4-pro",
    });

    expect(plan.strategy).toBe("crosscheck");
    expect(plan.jobs.map((j) => j.lens.id)).toEqual(["risk", "design"]);
    expect(plan.jobs.map((j) => j.model.label)).toEqual([
      "deepseek/deepseek-v4-pro",
      "zai/glm-5.1",
    ]);
    expect(plan.validator.label).toBe("deepseek/deepseek-v4-pro");
  });

  it("builds a council plan with four lenses and cycles provided models", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "council",
      reviewModels: "deepseek/deepseek-v4-pro,zai/glm-5.1",
    });

    expect(plan.jobs.map((j) => j.lens.id)).toEqual([
      "risk",
      "design",
      "tests",
      "operations",
    ]);
    expect(plan.jobs.map((j) => j.model.label)).toEqual([
      "deepseek/deepseek-v4-pro",
      "zai/glm-5.1",
      "deepseek/deepseek-v4-pro",
      "zai/glm-5.1",
    ]);
  });

  it("drops empty model list entries", () => {
    expect(parseModelList(" deepseek/a, ,zai/b ", baseInputs).map((m) => m.label)).toEqual([
      "deepseek/a",
      "zai/b",
    ]);
  });
});
