import { describe, expect, it } from "bun:test";
import {
  applyConfigDefaults,
  formatConfigPromptBlock,
  loadElekConfig,
  parseElekConfig,
  type ElekConfig,
} from "../src/config";
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
  configPath: ".elek.yml",
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

describe("elek config", () => {
  it("parses the supported .elek.yml keys", () => {
    const warnings: string[] = [];
    const config = parseElekConfig(
      `
review_strategy: crosscheck
review_models: deepseek/deepseek-v4-pro,openrouter/moonshotai/kimi-k2.7-code
validator_model: deepseek/deepseek-v4-pro
cost_rates: openrouter/moonshotai/kimi-k2.7-code=0.95:4
severity_threshold: important
ignore_paths:
  - docs/**
  - "*.md"
instructions:
  - Treat auth changes as security-sensitive.
  - Require tests for parser changes.
`,
      (message) => warnings.push(message),
    );

    expect(warnings).toEqual([]);
    expect(config).toEqual({
      reviewStrategy: "crosscheck",
      reviewModels: "deepseek/deepseek-v4-pro,openrouter/moonshotai/kimi-k2.7-code",
      validatorModel: "deepseek/deepseek-v4-pro",
      costRates: "openrouter/moonshotai/kimi-k2.7-code=0.95:4",
      severityThreshold: "important",
      ignorePaths: ["docs/**", "*.md"],
      instructions: [
        "Treat auth changes as security-sensitive.",
        "Require tests for parser changes.",
      ],
    });
  });

  it("warns and skips unknown keys and invalid severity", () => {
    const warnings: string[] = [];
    const config = parseElekConfig(
      `
severity_threshold: advisory
unknown_key: value
ignore_paths: [dist/**, coverage/**]
`,
      (message) => warnings.push(message),
    );

    expect(config.severityThreshold).toBeUndefined();
    expect(config.ignorePaths).toEqual(["dist/**", "coverage/**"]);
    expect(warnings).toEqual([
      "Ignoring invalid severity_threshold: advisory",
      "Ignoring unknown config key: unknown_key",
    ]);
  });

  it("applies config defaults without overriding explicit action inputs", () => {
    const config: ElekConfig = {
      reviewStrategy: "council",
      reviewModels: "openrouter/model-a",
      validatorModel: "deepseek/model-b",
      costRates: "deepseek/model-b=1:2",
      ignorePaths: [],
      instructions: [],
    };

    expect(applyConfigDefaults({ ...baseInputs, reviewStrategy: "" }, config)).toMatchObject({
      reviewStrategy: "council",
      reviewModels: "openrouter/model-a",
      validatorModel: "deepseek/model-b",
      costRates: "deepseek/model-b=1:2",
    });

    expect(applyConfigDefaults({
      ...baseInputs,
      reviewStrategy: "solo",
      reviewModels: "explicit/model",
      validatorModel: "explicit/validator",
      costRates: "explicit/model=3:4",
    }, config)).toMatchObject({
      reviewStrategy: "solo",
      reviewModels: "explicit/model",
      validatorModel: "explicit/validator",
      costRates: "explicit/model=3:4",
    });
  });

  it("formats prompt policy for repo-specific instructions", () => {
    expect(formatConfigPromptBlock({
      severityThreshold: "important",
      ignorePaths: ["docs/**"],
      instructions: ["Treat migrations as operational risk."],
    })).toEqual([
      "severity_threshold: important",
      "Only surface findings at or above important severity.",
      "ignore_paths:",
      "- docs/**",
      "Do not surface findings for ignored paths unless they create a security or runtime issue outside the ignored path.",
      "instructions:",
      "- Treat migrations as operational risk.",
    ]);
  });

  it("treats none as disabling config loading", () => {
    expect(loadElekConfig("none")).toEqual({ ignorePaths: [], instructions: [] });
  });
});
