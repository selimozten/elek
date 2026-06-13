import { describe, expect, it } from "bun:test";
import {
  buildLensPrompt,
  buildSynthesisPrompt,
  parseModelList,
  parseModelSpec,
  resolveReviewPlan,
  resolveReviewPlanSupport,
  resolveReviewStrategy,
} from "../src/review/strategy";
import type { GitHubData } from "../src/github/data";
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
  showCost: true,
  costRates: "",
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
    });

    expect(prompt).toContain("Your lens: Risk Review");
    expect(prompt).toContain("Focus: Correctness and security.");
    expect(prompt).toContain("Available tools: `read`, `grep`, `find`, `ls`");
    expect(prompt).toContain("Do not paste raw diff blocks into your candidate report");
    expect(prompt).toContain("Do not claim external packages, GitHub Actions");
    expect(prompt).toContain("Review this pull request.");
    expect(prompt).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(prompt).toContain("(no description)");
    expect(prompt).toContain("<comments>");
    expect(prompt).toContain("<review_comments>");
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
    });

    expect(prompt).toContain("Treat existing comments and review comments as already-visible context");
    expect(prompt).toContain("Do not surface claims that external packages");
    expect(prompt).toContain("### Available tools (via the `mcp` proxy)");
    expect(prompt).toContain('mcp({tool: "elek_review_create_inline_comment"');
    expect(prompt).toContain("Optional fields: `side`, `startLine`, `confirmed`, and `commit_id`.");
    expect(prompt).toContain("`args` is a JSON STRING");
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
      diff: `diff --git a/src/a.ts b/src/a.ts\n${"+x\n".repeat(40_000)}`,
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

    expect(prompt).toContain("... diff truncated for prompt budget");
    expect(prompt.length).toBeLessThan(70_000);
  });
});
