import { describe, expect, it } from "bun:test";
import {
  buildLensPrompt,
  buildSynthesisPrompt,
  countChangedDiffLines,
  downgradeReviewStrategy,
  parseModelList,
  parseModelSpec,
  resolveReviewPlan,
  resolveReviewPlanSupport,
  resolveReviewStrategy,
  selectReviewPlanWithinBudget,
  selectReviewPlanWithinDiffSize,
} from "../src/review/strategy";
import type { GitHubData } from "../src/github/data";
import type { ActionInputs } from "../src/types";
import type { ReviewCost } from "../src/review/cost";

const baseInputs: ActionInputs = {
  triggerPhrase: "@pi",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  thinking: "medium",
  prompt: "",
  systemPrompt: "",
  maxTurns: 20,
  runTimeoutSeconds: 600,
  tools: "",
  configPath: ".elek.yml",
  branchPrefix: "elek/",
  actorFilter: "",
  allowedBots: "",
  stickyComment: true,
  mode: "review",
  reviewStrategy: "solo",
  reviewModels: "",
  reviewAgentCount: undefined,
  validatorModel: "",
  validatorThinking: "",
  severityThreshold: "",
  showCost: true,
  costRates: "",
  maxCostUsd: undefined,
};

const dataFixture: GitHubData = {
  type: "pr",
  title: "Improve review orchestration",
  body: "",
  author: "alice",
  diff: "diff --git a/src/a.ts b/src/a.ts\n+export const ok = true;",
  comments: ["[github-actions]: prior summary"],
  reviewComments: ["src/a.ts:1 prior inline finding"],
  labels: [],
  assignees: [],
  entityNumber: 7,
  pr: { headRef: "feature/review", baseRef: "main" },
};

describe("review strategy", () => {
  it("keeps solo as the safe default", () => {
    expect(resolveReviewStrategy(undefined)).toBe("solo");
    expect(resolveReviewStrategy("nonsense")).toBe("solo");
  });

  it("accepts useful aliases without exposing the internal naming", () => {
    expect(resolveReviewStrategy("dual")).toBe("crosscheck");
    expect(resolveReviewStrategy("swarm")).toBe("council");
    expect(resolveReviewStrategy("thermo-nuclear")).toBe("thermos");
    expect(resolveReviewStrategy("multi-agent")).toBe("thermos");
  });

  it("parses provider-qualified model specs as self-routing pi models", () => {
    const spec = parseModelSpec("openrouter/moonshotai/kimi-k2.7-code", baseInputs);
    expect(spec).toEqual({
      provider: "openrouter",
      model: "openrouter/moonshotai/kimi-k2.7-code",
      label: "openrouter/moonshotai/kimi-k2.7-code",
    });
  });

  it("treats trailing-slash provider specs as provider defaults", () => {
    expect(parseModelSpec("openrouter/", baseInputs)).toEqual({
      provider: "openrouter",
      model: "",
      label: "openrouter",
    });
    expect(parseModelSpec("openrouter//moonshotai/kimi-k2.7-code/", baseInputs)).toEqual({
      provider: "openrouter",
      model: "openrouter/moonshotai/kimi-k2.7-code",
      label: "openrouter/moonshotai/kimi-k2.7-code",
    });
  });

  it("normalizes leading-slash model specs", () => {
    expect(parseModelSpec("/deepseek-v4-pro", baseInputs)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      label: "deepseek/deepseek-v4-pro",
    });
    expect(parseModelSpec("/", baseInputs)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      label: "deepseek/deepseek-v4-pro",
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
      reviewModels: "deepseek/deepseek-v4-pro,openrouter/moonshotai/kimi-k2.7-code",
      validatorModel: "deepseek/deepseek-v4-pro",
    });

    expect(plan.strategy).toBe("crosscheck");
    expect(plan.reusedModels).toBe(false);
    expect(plan.jobs.map((j) => j.lens.id)).toEqual(["risk", "design"]);
    expect(plan.jobs.map((j) => j.model.label)).toEqual([
      "deepseek/deepseek-v4-pro",
      "openrouter/moonshotai/kimi-k2.7-code",
    ]);
    expect(plan.validator.label).toBe("deepseek/deepseek-v4-pro");
    expect(plan.validatorReview?.lens.id).toBe("validator-self-review");
    expect(plan.validatorReview?.model.label).toBe("deepseek/deepseek-v4-pro");
  });

  it("builds a council plan with four lenses and cycles provided models", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "council",
      reviewModels: "deepseek/deepseek-v4-pro,openrouter/moonshotai/kimi-k2.7-code",
    });

    expect(plan.jobs.map((j) => j.lens.id)).toEqual([
      "risk",
      "design",
      "tests",
      "operations",
    ]);
    expect(plan.jobs.map((j) => j.model.label)).toEqual([
      "deepseek/deepseek-v4-pro",
      "openrouter/moonshotai/kimi-k2.7-code",
      "deepseek/deepseek-v4-pro",
      "openrouter/moonshotai/kimi-k2.7-code",
    ]);
    expect(plan.reusedModels).toBe(true);
    expect(plan.validatorReview?.role).toBe("validator-review");
  });

  it("builds a thermos plan with N parallel audit agents and validator self-review", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      reviewStrategy: "thermos",
      reviewAgentCount: 6,
      reviewModels: "together/moonshotai/Kimi-K2.7-Code,deepseek/deepseek-v4-pro,openai/gpt-5.5",
      validatorModel: "openai/gpt-5.5",
    });

    expect(plan.strategy).toBe("thermos");
    expect(plan.jobs).toHaveLength(6);
    expect(plan.jobs.map((j) => j.lens.id)).toEqual([
      "security-correctness",
      "side-effects",
      "devex-config",
      "feature-gates",
      "tests-ops",
      "independent-audit-6",
    ]);
    expect(plan.jobs.map((j) => j.model.label)).toEqual([
      "together/moonshotai/Kimi-K2.7-Code",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.5",
      "together/moonshotai/Kimi-K2.7-Code",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.5",
    ]);
    expect(plan.reusedModels).toBe(true);
    expect(plan.validator.label).toBe("openai/gpt-5.5");
    expect(plan.validatorReview).toMatchObject({
      role: "validator-review",
      lens: { id: "validator-self-review" },
      model: { label: "openai/gpt-5.5" },
    });
  });

  it("downgrades expensive strategies one step at a time", () => {
    expect(downgradeReviewStrategy("thermos")).toBe("council");
    expect(downgradeReviewStrategy("council")).toBe("crosscheck");
    expect(downgradeReviewStrategy("crosscheck")).toBe("solo");
    expect(downgradeReviewStrategy("solo")).toBeUndefined();
  });

  it("counts changed diff lines without counting file headers", () => {
    expect(countChangedDiffLines([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "-old",
      "+new",
      "----",
      "++++",
      " context",
      "+another",
    ].join("\n"))).toBe(5);
    expect(countChangedDiffLines(undefined)).toBeUndefined();
  });

  it("preserves thermos coverage when changed lines exceed default warning thresholds", () => {
    const inputs = { ...baseInputs, reviewStrategy: "thermos" };
    const result = selectReviewPlanWithinDiffSize({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      changedLines: 250_000,
    });

    expect(result.plan.strategy).toBe("thermos");
    expect(result.support.enabled).toBe(true);
    expect(result.events.map((event) => event.message)).toEqual([
      "[size] changed_lines=250000 strategy=thermos max_council_changed_lines=200000; preserving thermos coverage and using per-file diff prompt slices.",
    ]);
  });

  it("keeps the requested strategy when explicit size limits allow it", () => {
    const inputs = {
      ...baseInputs,
      reviewStrategy: "council",
      maxCouncilChangedLines: 5_000,
      maxCrosscheckChangedLines: 6_000,
    };
    const result = selectReviewPlanWithinDiffSize({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      changedLines: 3_500,
    });

    expect(result.plan.strategy).toBe("council");
    expect(result.support.enabled).toBe(true);
    expect(result.events).toEqual([]);
  });

  it("lets zero disable a strategy size guard", () => {
    const inputs = { ...baseInputs, reviewStrategy: "crosscheck", maxCrosscheckChangedLines: 0 };
    const result = selectReviewPlanWithinDiffSize({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      changedLines: 20_000,
    });

    expect(result.plan.strategy).toBe("crosscheck");
    expect(result.support.enabled).toBe(true);
    expect(result.events).toEqual([]);
  });

  it("keeps the requested strategy when no budget cap is configured", () => {
    let estimates = 0;
    const plan = resolveReviewPlan({ ...baseInputs, reviewStrategy: "council" });
    const result = selectReviewPlanWithinBudget({
      inputs: { ...baseInputs, reviewStrategy: "council" },
      initialPlan: plan,
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: () => {
        estimates++;
        return [reviewCost(1)];
      },
    });

    expect(result.plan.strategy).toBe("council");
    expect(result.support.enabled).toBe(true);
    expect(result.events).toEqual([]);
    expect(estimates).toBe(0);
  });

  it("keeps the requested strategy when the known input estimate is within budget", () => {
    const plan = resolveReviewPlan({ ...baseInputs, reviewStrategy: "crosscheck" });
    const result = selectReviewPlanWithinBudget({
      inputs: { ...baseInputs, reviewStrategy: "crosscheck", maxCostUsd: 0.05 },
      initialPlan: plan,
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: () => [reviewCost(0.01)],
    });

    expect(result.plan.strategy).toBe("crosscheck");
    expect(result.support.enabled).toBe(true);
    expect(result.events.map((event) => event.level)).toEqual(["log"]);
  });

  it("downgrades one step when the downgraded strategy fits the budget", () => {
    const inputs = { ...baseInputs, reviewStrategy: "council", maxCostUsd: 0.05 };
    const result = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: (plan) => [reviewCost(plan.strategy === "council" ? 0.10 : 0.01)],
    });

    expect(result.plan.strategy).toBe("crosscheck");
    expect(result.support.enabled).toBe(true);
    expect(result.events.some((event) => event.message.includes("downgrading to crosscheck"))).toBe(true);
  });

  it("downgrades to solo when every multi-lens strategy exceeds the budget", () => {
    const inputs = { ...baseInputs, reviewStrategy: "council", maxCostUsd: 0.05 };
    const estimatedStrategies: string[] = [];
    const result = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: (plan) => {
        estimatedStrategies.push(plan.strategy);
        return [reviewCost(0.10)];
      },
    });

    expect(result.plan.strategy).toBe("solo");
    expect(result.support.enabled).toBe(false);
    expect(estimatedStrategies).toEqual(["council", "crosscheck"]);
    expect(result.events.filter((event) => event.message.includes("downgrading")).length).toBe(2);
  });

  it("downgrades when the known priced portion already exceeds the budget despite unknown rates", () => {
    const inputs = { ...baseInputs, reviewStrategy: "crosscheck", maxCostUsd: 0.05 };
    const result = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: () => [reviewCost(0.06), reviewCost(0, "unknown")],
    });

    expect(result.plan.strategy).toBe("solo");
    expect(result.events.some((event) => event.message.includes("incomplete pricing"))).toBe(true);
  });

  it("warns but keeps the strategy when unknown rates leave the known portion within budget", () => {
    const inputs = { ...baseInputs, reviewStrategy: "crosscheck", maxCostUsd: 0.05 };
    const result = selectReviewPlanWithinBudget({
      inputs,
      initialPlan: resolveReviewPlan(inputs),
      supportContext: { isPR: true, mode: "review" },
      estimateCosts: () => [reviewCost(0.01), reviewCost(0, "unknown")],
    });

    expect(result.plan.strategy).toBe("crosscheck");
    expect(result.events.map((event) => event.level)).toEqual(["warn", "log"]);
  });

  it("uses the provider default model when no reviewer model list is supplied", () => {
    const plan = resolveReviewPlan({
      ...baseInputs,
      model: "",
      reviewStrategy: "crosscheck",
      reviewModels: "",
    });

    expect(plan.jobs.map((j) => j.model)).toEqual([
      { provider: "deepseek", model: "", label: "deepseek" },
      { provider: "deepseek", model: "", label: "deepseek" },
    ]);
  });

  it("drops empty model list entries", () => {
    expect(parseModelList(" deepseek/a, ,openrouter/b ", baseInputs).map((m) => m.label)).toEqual([
      "deepseek/a",
      "openrouter/b",
    ]);
  });

  it("enables non-solo strategies only for PR review mode", () => {
    expect(resolveReviewPlanSupport("crosscheck", { isPR: true, mode: "review" })).toEqual({
      enabled: true,
    });
  });

  it("warns when a non-solo strategy is requested for review+edit", () => {
    const support = resolveReviewPlanSupport("crosscheck", {
      isPR: true,
      mode: "review+edit",
    });

    expect(support.enabled).toBe(false);
    expect(support.warning).toContain("only supported in mode=review");
    expect(support.warning).toContain("mode=review+edit");
  });

  it("warns when a non-solo strategy is requested outside PR context", () => {
    const support = resolveReviewPlanSupport("council", {
      isPR: false,
      mode: "review",
    });

    expect(support.enabled).toBe(false);
    expect(support.warning).toContain("requires a pull request");
  });

  it("builds a lens prompt with the lens focus and diff context", () => {
    const prompt = buildLensPrompt({
      data: dataFixture,
      userRequest: "",
      lens: {
        id: "risk",
        title: "Risk Review",
        focus: "Correctness and security.",
      },
      modelLabel: "deepseek/deepseek-v4-pro",
      repoConfig: {
        severityThreshold: "important",
        ignorePaths: ["docs/**"],
        instructions: ["Treat auth changes as security-sensitive."],
      },
    });

    expect(prompt).toContain("<elek_config>");
    expect(prompt).toContain("severity_threshold: important");
    expect(prompt).toContain("- Treat auth changes as security-sensitive.");
    expect(prompt).toContain("Your lens: Risk Review");
    expect(prompt).toContain("Focus: Correctness and security.");
    expect(prompt).toContain("Available tools: `read`, `grep`, `find`, `ls`");
    expect(prompt).toContain("Do not paste raw diff blocks into your candidate report");
    expect(prompt).toContain("Do not claim external packages, GitHub Actions");
    expect(prompt).toContain("Thermos-style audit calibration:");
    expect(prompt).toContain("Never overstate severity; false positives are review failures.");
    expect(prompt).toContain("Every finding must include severity, confidence, evidence, impact, and a concrete fix.");
    expect(prompt).toContain("Finding acceptance gates:");
    expect(prompt).toContain("A finding must identify a concrete failure path from changed code");
    expect(prompt).toContain("Reject findings that contradict the diff, surrounding repo context, or already-visible comments.");
    expect(prompt).toContain("- Confidence: high|medium");
    expect(prompt).toContain("Review this pull request.");
    expect(prompt).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(prompt).toContain("(no description)");
    expect(prompt).toContain("<comments>");
    expect(prompt).toContain("<review_comments>");
  });

  it("can hide discussion from independent lens prompts for fresh audits", () => {
    const prompt = buildLensPrompt({
      data: dataFixture,
      userRequest: "",
      lens: {
        id: "security-correctness",
        title: "Security & Correctness Audit",
        focus: "Bugs and security.",
      },
      modelLabel: "openai/gpt-5.5",
      includeDiscussion: false,
    });

    expect(prompt).not.toContain("<comments>");
    expect(prompt).not.toContain("<review_comments>");
    expect(prompt).toContain("Do your audit with fresh eyes.");
  });

  it("uses the correct fallback user request for issue lens prompts", () => {
    const prompt = buildLensPrompt({
      data: { ...dataFixture, type: "issue", diff: undefined, pr: undefined },
      userRequest: "",
      lens: {
        id: "operations",
        title: "Operational Review",
        focus: "Rollout safety.",
      },
      modelLabel: "deepseek/deepseek-v4-pro",
    });

    expect(prompt).toContain("Review this issue.");
    expect(prompt).toContain("(diff unavailable; inspect files from the workspace if needed)");
  });

  it("builds a synthesis prompt with candidate reports and visible comment context", () => {
    const prompt = buildSynthesisPrompt({
      data: dataFixture,
      userRequest: "focus on regressions",
      modelLabel: "deepseek/deepseek-v4-pro",
      jobRunLink: "https://github.com/selimozten/elek/actions/runs/1",
      commentId: 123,
      reports: [
        {
          lens: { id: "risk", title: "Risk Review", focus: "Correctness." },
          modelLabel: "deepseek/deepseek-v4-pro",
          output: "Potential issue in src/a.ts",
          conclusion: "success",
        },
        {
          lens: { id: "design", title: "Design Review", focus: "Maintainability." },
          modelLabel: "openrouter/moonshotai/kimi-k2.7-code",
          output: "",
          conclusion: "failure",
        },
      ],
      repoConfig: {
        severityThreshold: "important",
        ignorePaths: ["docs/**"],
        instructions: ["Treat auth changes as security-sensitive."],
      },
    });

    expect(prompt).toContain("<elek_config>");
    expect(prompt).toContain("ignore_paths:");
    expect(prompt).toContain("Treat existing comments and review comments as already-visible context");
    expect(prompt).toContain("Do not surface low-confidence findings.");
    expect(prompt).toContain("Finding acceptance gates:");
    expect(prompt).toContain("Reject findings that depend on unverified external facts");
    expect(prompt).toContain("drop it instead of posting a caveat.");
    expect(prompt).toContain("Fix: the smallest concrete change required");
    expect(prompt).toContain("Do not surface claims that external packages");
    expect(prompt).toContain("temporary workflow-test scaffolding");
    expect(prompt).toContain("omitted or disabled review-cost budget");
    expect(prompt).toContain("### Available tools (via the `mcp` proxy)");
    expect(prompt).toContain('mcp({tool: "elek_review_create_inline_comment"');
    expect(prompt).toContain("Optional fields: `side`, `startLine`, `confirmed`, and `commit_id`.");
    expect(prompt).toContain("`args` is a JSON STRING");
    expect(prompt).toContain("Elek will publish your concise final summary host-side.");
    expect(prompt).toContain("do not mention that failure in the public review");
    expect(prompt).toContain("Never include thinking traces");
    expect(prompt).toContain('<reviewer_report lens="risk" title="Risk Review"');
    expect(prompt).toContain('<reviewer_report lens="design" title="Design Review"');
    expect(prompt).toContain("Potential issue in src/a.ts");
    expect(prompt).toContain("(no output)");
    expect(prompt).toContain("<comments>");
    expect(prompt).toContain("<review_comments>");
    expect(prompt).toContain("focus on regressions");
    expect(prompt).toContain("comment_id: 123");
  });

  it("uses a tighter diff budget for final synthesis prompts", () => {
    const longData = {
      ...dataFixture,
      diff: `diff --git a/src/a.ts b/src/a.ts\n${"+x\n".repeat(100_000)}`,
      comments: [],
      reviewComments: [],
    };

    const prompt = buildSynthesisPrompt({
      data: longData,
      userRequest: "",
      modelLabel: "deepseek/deepseek-v4-pro",
      jobRunLink: "https://github.com/selimozten/elek/actions/runs/1",
      reports: [],
    });

    expect(prompt).toContain("... diff truncated by file for prompt budget");
    expect(prompt.length).toBeLessThan(220_000);
  });
});

function reviewCost(costUsd: number, source: ReviewCost["source"] = "builtin"): ReviewCost {
  return {
    inputTokens: 100,
    outputTokens: 0,
    costUsd,
    estimated: true,
    modelLabel: "deepseek/deepseek-v4-pro",
    source,
  };
}
