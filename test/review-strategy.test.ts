import { describe, expect, it } from "bun:test";
import {
  buildSingleSessionReviewRequest,
  parseReviewLensList,
  resolveReviewPlan,
  resolveReviewPlanSupport,
  resolveReviewStrategy,
} from "../src/review/strategy";
import type { ActionInputs } from "../src/types";

const baseInputs: ActionInputs = {
  triggerPhrase: "@pi",
  provider: "together",
  model: "together/deepseek-ai/DeepSeek-V4-Pro-0813",
  thinking: "high",
  prompt: "",
  systemPrompt: "",
  tools: "read,grep,find,ls",
  configPath: ".elek.yml",
  branchPrefix: "elek/",
  actorFilter: "",
  allowedBots: "",
  stickyComment: true,
  mode: "review",
  reviewStrategy: "solo",
  reviewModels: "",
  reviewLenses: "",
  validatorModel: "",
  validatorThinking: "",
  severityThreshold: "",
  showCost: true,
  costRates: "",
};

describe("single-session review strategy", () => {
  it("keeps solo as the default", () => {
    expect(resolveReviewStrategy(undefined)).toBe("solo");
    expect(resolveReviewStrategy("nonsense")).toBe("solo");
  });

  it("keeps useful strategy aliases", () => {
    expect(resolveReviewStrategy("dual")).toBe("crosscheck");
    expect(resolveReviewStrategy("swarm")).toBe("council");
    expect(resolveReviewStrategy("thermo-nuclear")).toBe("thermos");
  });

  it("uses the risk and design lenses in one plan", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "thermos",
      reviewModels: "legacy/model-a,legacy/model-b",
      validatorModel: "legacy/model-c",
    });

    expect(plan.jobs.map((job) => job.lens.id)).toEqual(["risk", "design"]);
    expect(plan).not.toHaveProperty("validator");
    expect(plan).not.toHaveProperty("validatorReview");
  });

  it("uses configured domain lenses and rejects unknown values", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "thermos",
      reviewLenses: "security-correctness,contract-drift,mobile-runtime",
    });

    expect(plan.jobs.map((job) => job.lens.id)).toEqual([
      "security-correctness",
      "contract-drift",
      "mobile-runtime",
    ]);
    expect(parseReviewLensList("risk,risk,design").map((lens) => lens.id)).toEqual([
      "risk",
      "design",
    ]);
    expect(() => parseReviewLensList("not-a-lens")).toThrow("Unknown review_lenses");
  });

  it("keeps strategy lens limits", () => {
    expect(() => resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "crosscheck",
      reviewLenses: "risk,design,tests",
    })).toThrow("supports at most 2 review_lenses");
  });

  it("asks one session to use the selected lenses and repository tools", () => {
    const request = buildSingleSessionReviewRequest(
      "Review this PR.",
      resolveReviewPlan({ ...baseInputs, reviewStrategy: "thermos" }),
    );

    expect(request).toContain("Use one review session.");
    expect(request).toContain("Thermos Security & Correctness Review");
    expect(request).toContain("Thermos Code Quality Review");
    expect(request).toContain("Then apply the Ponytail lens");
    expect(request).toContain("Use read and search tools only when they resolve a specific uncertainty");
    expect(request).not.toContain("without repository tools");
  });

  it("enables lens plans only for pull request review mode", () => {
    expect(resolveReviewPlanSupport("thermos", { isPR: true, mode: "review" })).toEqual({
      enabled: true,
    });
    expect(resolveReviewPlanSupport("thermos", { isPR: false, mode: "review" }).warning).toContain(
      "requires a pull request",
    );
    expect(resolveReviewPlanSupport("thermos", { isPR: true, mode: "agent" }).warning).toContain(
      "only supported in mode=review",
    );
  });
});
