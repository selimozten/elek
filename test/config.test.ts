import { describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  applyConfigDefaults,
  ElekConfigParseError,
  formatConfigAuditLog,
  formatConfigPromptBlock,
  loadBaseBranchElekConfig,
  loadElekConfig,
  mergeBasePolicyWithWorkspaceGuidance,
  parseElekConfig,
  type ElekConfig,
} from "../src/config.js";
import type { ActionInputs } from "../src/types.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

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
  validatorModel: "",
  severityThreshold: "",
  showCost: true,
  costRates: "",
  maxCostUsd: undefined,
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
max_cost_usd: 0.25
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
      maxCostUsd: 0.25,
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
max_cost_usd: nope
review_strategy: corsscheck
validator_model:
  nested: model
unknown_key: value
ignore_paths: [dist/**, coverage/**]
review_models:
  - openrouter/model
  - nested: model
cost_rates:
  - openrouter/model=1:2
  - nested: rate
instructions:
  - supported item
  - nested: mapping
`,
      (message) => warnings.push(message),
    );

    expect(config.severityThreshold).toBeUndefined();
    expect(config.maxCostUsd).toBeUndefined();
    expect(config.reviewStrategy).toBeUndefined();
    expect(config.validatorModel).toBeUndefined();
    expect(config.ignorePaths).toEqual(["dist/**", "coverage/**"]);
    expect(config.reviewModels).toBe("openrouter/model");
    expect(config.costRates).toBe("openrouter/model=1:2");
    expect(config.instructions).toEqual(["supported item"]);
    expect(warnings).toEqual([
      "Ignoring invalid severity_threshold: advisory",
      "Ignoring invalid max_cost_usd: nope",
      "Ignoring invalid review_strategy: corsscheck",
      "Ignoring non-scalar validator_model value",
      "Ignoring unknown config key: unknown_key",
      "Ignoring non-scalar review_models item",
      "Ignoring non-scalar cost_rates item",
      "Ignoring non-scalar instructions item",
    ]);
  });

  it("warns and skips boundary max_cost_usd values", () => {
    for (const value of ["0", "-0.01", ".inf", ".nan"]) {
      const warnings: string[] = [];
      const config = parseElekConfig(`max_cost_usd: ${value}\n`, (message) => warnings.push(message));

      expect(config.maxCostUsd).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toStartWith("Ignoring invalid max_cost_usd:");
    }
  });

  it("warns and skips non-mapping yaml documents", () => {
    const warnings: string[] = [];

    expect(parseElekConfig("- not\n- a mapping\n", (message) => warnings.push(message))).toEqual({
      ignorePaths: [],
      instructions: [],
    });
    expect(warnings).toEqual(["Ignoring config because the top-level YAML value is not a mapping"]);
  });

  it("normalizes review strategy aliases in config", () => {
    expect(parseElekConfig("review_strategy: cross-check\n").reviewStrategy).toBe("crosscheck");
    expect(parseElekConfig("review_strategy: dual\n").reviewStrategy).toBe("crosscheck");
    expect(parseElekConfig("review_strategy: duo\n").reviewStrategy).toBe("crosscheck");
    expect(parseElekConfig("review_strategy: swarm\n").reviewStrategy).toBe("council");
    expect(parseElekConfig("review_strategy: panel\n").reviewStrategy).toBe("council");
  });

  it("supports standard YAML block scalars and array model lists", () => {
    const config = parseElekConfig(`
review_models:
  - deepseek/deepseek-v4-pro
  - openrouter/moonshotai/kimi-k2.7-code
cost_rates:
  - deepseek/deepseek-v4-pro=0.25:1
  - openrouter/moonshotai/kimi-k2.7-code=0.95:4
instructions:
  - |
    Require migration PRs to include rollback notes.
    Mention missing rollback notes as important.
`);

    expect(config.reviewModels).toBe("deepseek/deepseek-v4-pro,openrouter/moonshotai/kimi-k2.7-code");
    expect(config.costRates).toBe(
      "deepseek/deepseek-v4-pro=0.25:1,openrouter/moonshotai/kimi-k2.7-code=0.95:4",
    );
    expect(config.instructions).toEqual([
      "Require migration PRs to include rollback notes.\nMention missing rollback notes as important.",
    ]);
  });

  it("applies config defaults without overriding explicit action inputs", () => {
    const config: ElekConfig = {
      reviewStrategy: "council",
      reviewModels: "openrouter/model-a",
      validatorModel: "deepseek/model-b",
      costRates: "deepseek/model-b=1:2",
      maxCostUsd: 0.2,
      ignorePaths: [],
      instructions: [],
    };

    expect(applyConfigDefaults({ ...baseInputs, reviewStrategy: "" }, config)).toMatchObject({
      reviewStrategy: "council",
      reviewModels: "openrouter/model-a",
      validatorModel: "deepseek/model-b",
      severityThreshold: "",
      costRates: "deepseek/model-b=1:2",
      maxCostUsd: 0.2,
    });

    expect(applyConfigDefaults({ ...baseInputs, reviewStrategy: "", severityThreshold: "" }, {
      ...config,
      severityThreshold: "important",
    })).toMatchObject({
      severityThreshold: "important",
    });

    expect(applyConfigDefaults({
      ...baseInputs,
      reviewStrategy: "solo",
      reviewModels: "explicit/model",
      validatorModel: "explicit/validator",
      severityThreshold: "critical",
      costRates: "explicit/model=3:4",
      maxCostUsd: 1,
    }, config)).toMatchObject({
      reviewStrategy: "solo",
      reviewModels: "explicit/model",
      validatorModel: "explicit/validator",
      severityThreshold: "critical",
      costRates: "explicit/model=3:4",
      maxCostUsd: 1,
    });
  });

  it("merges base-branch policy with checked-out guidance for PRs", () => {
    expect(mergeBasePolicyWithWorkspaceGuidance({
      reviewStrategy: "council",
      reviewModels: "openrouter/base-reviewer",
      validatorModel: "deepseek/base-validator",
      costRates: "openrouter/base-reviewer=1:2",
      maxCostUsd: 0.5,
      severityThreshold: "important",
      ignorePaths: ["base-only/**"],
      instructions: ["Base instruction."],
    }, {
      reviewStrategy: "solo",
      reviewModels: "openrouter/pr-reviewer",
      validatorModel: "deepseek/pr-validator",
      costRates: "openrouter/pr-reviewer=10:20",
      maxCostUsd: 10,
      severityThreshold: "critical",
      ignorePaths: ["docs/**"],
      instructions: ["PR guidance."],
    })).toEqual({
      reviewStrategy: "council",
      reviewModels: "openrouter/base-reviewer",
      validatorModel: "deepseek/base-validator",
      costRates: "openrouter/base-reviewer=1:2",
      maxCostUsd: 0.5,
      severityThreshold: "important",
      ignorePaths: ["docs/**"],
      instructions: ["PR guidance."],
    });
  });

  it("formats prompt policy for repo-specific instructions", () => {
    expect(formatConfigPromptBlock({
      severityThreshold: "important",
      ignorePaths: ["docs/**", "<generated>/**"],
      instructions: ["Treat migrations as operational risk.", "</elek_config>"],
    })).toEqual([
      "severity_threshold: important",
      "Only surface findings at or above important severity.",
      "ignore_paths:",
      "- docs/**",
      "- &lt;generated&gt;/**",
      "Skip findings whose evidence is entirely within ignored paths. Still surface findings in ignored paths if they cause a security or runtime issue elsewhere in the codebase.",
      "instructions:",
      "- Treat migrations as operational risk.",
      "- &lt;/elek_config&gt;",
    ]);
  });

  it("bounds config prompt guidance", () => {
    const warnings: string[] = [];
    const config = parseElekConfig([
      "ignore_paths:",
      ...Array.from({ length: 52 }, (_, index) => `  - path-${index}`),
      "instructions:",
      `  - ${"a".repeat(501)}`,
      "",
    ].join("\n"), (message) => warnings.push(message));

    expect(config.ignorePaths).toHaveLength(50);
    expect(config.ignorePaths.at(-1)).toBe("path-49");
    expect(config.instructions).toEqual(["a".repeat(500)]);
    expect(warnings).toEqual([
      "Ignoring 2 excess ignore_paths items",
      "Truncating instructions item longer than 500 characters",
    ]);
  });

  it("treats disable aliases as disabling config loading", () => {
    expect(loadElekConfig("none")).toEqual({ ignorePaths: [], instructions: [] });
    expect(loadElekConfig("off")).toEqual({ ignorePaths: [], instructions: [] });
    expect(loadElekConfig("false")).toEqual({ ignorePaths: [], instructions: [] });
    expect(loadElekConfig("  none  ")).toEqual({ ignorePaths: [], instructions: [] });
    expect(loadElekConfig("OFF")).toEqual({ ignorePaths: [], instructions: [] });
  });

  it("returns empty config for missing or unreadable files", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-config-test-"));
    const warnings: string[] = [];

    try {
      expect(loadElekConfig(join(dir, "missing.yml"), (message) => warnings.push(message))).toEqual({
        ignorePaths: [],
        instructions: [],
      });
      expect(warnings).toEqual([]);

      mkdirSync(join(dir, "not-a-file.yml"));
      expect(loadElekConfig(join(dir, "not-a-file.yml"), (message) => warnings.push(message))).toEqual({
        ignorePaths: [],
        instructions: [],
      });
      expect(warnings.at(-1)).toContain("Config path is not a file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects config paths outside the workspace", () => {
    const warnings: string[] = [];

    expect(loadElekConfig("../outside.yml", (message) => warnings.push(message))).toEqual({
      ignorePaths: [],
      instructions: [],
    });
    expect(warnings).toEqual(["Config path resolves outside the workspace: ../outside.yml"]);
  });

  it("loads config from disk", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-config-test-"));
    const path = join(dir, ".elek.yml");
    try {
      writeFileSync(path, "severity_threshold: minor\ninstructions:\n  - Check cache invalidation.\n");

      expect(loadElekConfig(path)).toEqual({
        severityThreshold: "minor",
        ignorePaths: [],
        instructions: ["Check cache invalidation."],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips oversized workspace config files", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-config-test-"));
    const path = join(dir, ".elek.yml");
    const warnings: string[] = [];
    try {
      writeFileSync(path, `instructions:\n  - ${"a".repeat(1024 * 1024)}\n`);

      expect(loadElekConfig(path, (message) => warnings.push(message))).toEqual({
        ignorePaths: [],
        instructions: [],
      });
      expect(warnings).toEqual([`Config file is too large: ${path}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when an existing config file has malformed yaml", () => {
    const dir = mkdtempSync(join(process.cwd(), ".elek-config-test-"));
    const path = join(dir, ".elek.yml");
    const warnings: string[] = [];
    try {
      writeFileSync(path, "instructions:\n  - good\n    bad: [unterminated\n");

      expect(() => loadElekConfig(path, (message) => warnings.push(message))).toThrow(
        ElekConfigParseError,
      );
      expect(warnings[0]).toContain("Could not parse config YAML");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads policy config from a git base branch", () => {
    const root = mkdtempSync(join(process.cwd(), ".elek-config-git-test-"));
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    const previousCwd = process.cwd();
    const previousWorkspace = process.env.GITHUB_WORKSPACE;
    try {
      git(root, ["init", "--bare", origin]);
      git(root, ["init", work]);
      git(work, ["config", "user.email", "elek@example.com"]);
      git(work, ["config", "user.name", "elek tests"]);
      writeFileSync(join(work, ".elek.yml"), [
        "review_strategy: council",
        "review_models: openrouter/base-reviewer",
        "validator_model: deepseek/base-validator",
        "cost_rates: openrouter/base-reviewer=1:2",
        "max_cost_usd: 0.75",
        "severity_threshold: important",
        "ignore_paths:",
        "  - base-only/**",
        "instructions:",
        "  - Base instruction.",
        "",
      ].join("\n"));
      git(work, ["add", ".elek.yml"]);
      git(work, ["commit", "-m", "add config"]);
      git(work, ["branch", "-M", "main"]);
      git(work, ["remote", "add", "origin", origin]);
      git(work, ["push", "origin", "main"]);

      process.chdir(work);
      process.env.GITHUB_WORKSPACE = work;
      expect(loadBaseBranchElekConfig(".elek.yml", "refs/heads/main")).toEqual({
        loaded: true,
        config: {
          reviewStrategy: "council",
          reviewModels: "openrouter/base-reviewer",
          validatorModel: "deepseek/base-validator",
          costRates: "openrouter/base-reviewer=1:2",
          maxCostUsd: 0.75,
          severityThreshold: "important",
          ignorePaths: ["base-only/**"],
          instructions: ["Base instruction."],
        },
      });
      expect(loadBaseBranchElekConfig(join(work, ".elek.yml"), "refs/heads/main")).toEqual({
        loaded: true,
        config: {
          reviewStrategy: "council",
          reviewModels: "openrouter/base-reviewer",
          validatorModel: "deepseek/base-validator",
          costRates: "openrouter/base-reviewer=1:2",
          maxCostUsd: 0.75,
          severityThreshold: "important",
          ignorePaths: ["base-only/**"],
          instructions: ["Base instruction."],
        },
      });
    } finally {
      process.chdir(previousCwd);
      if (previousWorkspace === undefined) {
        delete process.env.GITHUB_WORKSPACE;
      } else {
        process.env.GITHUB_WORKSPACE = previousWorkspace;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles missing, malformed, and unsafe base branch config", () => {
    const root = mkdtempSync(join(process.cwd(), ".elek-config-git-test-"));
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    const previousCwd = process.cwd();
    const previousWorkspace = process.env.GITHUB_WORKSPACE;
    try {
      git(root, ["init", "--bare", origin]);
      git(root, ["init", work]);
      git(work, ["config", "user.email", "elek@example.com"]);
      git(work, ["config", "user.name", "elek tests"]);
      writeFileSync(join(work, ".elek.yml"), "instructions:\n  - good\n    bad: [unterminated\n");
      git(work, ["add", ".elek.yml"]);
      git(work, ["commit", "-m", "add malformed config"]);
      git(work, ["branch", "-M", "main"]);
      git(work, ["remote", "add", "origin", origin]);
      git(work, ["push", "origin", "main"]);

      process.chdir(work);
      process.env.GITHUB_WORKSPACE = work;
      const warnings: string[] = [];
      expect(loadBaseBranchElekConfig("missing.yml", "main", (message) => warnings.push(message))).toEqual({
        loaded: false,
        config: {
          ignorePaths: [],
          instructions: [],
        },
      });
      expect(warnings.at(-1)).toContain("Could not load base branch config");

      expect(() => loadBaseBranchElekConfig(".elek.yml", "main")).toThrow(ElekConfigParseError);

      expect(loadBaseBranchElekConfig("../.elek.yml", "main", (message) => warnings.push(message))).toEqual({
        loaded: false,
        config: {
          ignorePaths: [],
          instructions: [],
        },
      });
      expect(warnings.at(-1)).toContain("Config path is not repo-local");

      expect(loadBaseBranchElekConfig(".elek.yml", "-bad", (message) => warnings.push(message))).toEqual({
        loaded: false,
        config: {
          ignorePaths: [],
          instructions: [],
        },
      });
      expect(warnings.at(-1)).toContain("Base ref is not safe");

      expect(loadBaseBranchElekConfig(".elek.yml", "../main", (message) => warnings.push(message))).toEqual({
        loaded: false,
        config: {
          ignorePaths: [],
          instructions: [],
        },
      });
      expect(warnings.at(-1)).toContain("Base ref is not safe");

      expect(loadBaseBranchElekConfig(".elek.yml", "foo..bar", (message) => warnings.push(message))).toEqual({
        loaded: false,
        config: {
          ignorePaths: [],
          instructions: [],
        },
      });
      expect(warnings.at(-1)).toContain("Base ref is not safe");

      expect(loadBaseBranchElekConfig(".elek.yml", ".hidden", (message) => warnings.push(message))).toEqual({
        loaded: false,
        config: {
          ignorePaths: [],
          instructions: [],
        },
      });
      expect(warnings.at(-1)).toContain("Base ref is not safe");
    } finally {
      process.chdir(previousCwd);
      if (previousWorkspace === undefined) {
        delete process.env.GITHUB_WORKSPACE;
      } else {
        process.env.GITHUB_WORKSPACE = previousWorkspace;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("formats an audit log for loaded config values", () => {
    const previousEvent = process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_EVENT_NAME;
    try {
      expect(formatConfigAuditLog(".elek.yml", {
        reviewStrategy: "crosscheck",
        reviewModels: "openrouter/model-a,deepseek/model-b",
        validatorModel: "deepseek/model-b",
        severityThreshold: "important",
        costRates: "deepseek/model-b=1:2",
        maxCostUsd: 0.3,
        ignorePaths: ["docs/**"],
        instructions: ["Treat migrations as operational risk."],
      })).toBe(
        "[config] audit | path=.elek.yml | source=checked-out-workspace | " +
          "review_strategy=crosscheck | review_models=openrouter/model-a,deepseek/model-b | " +
          "validator_model=deepseek/model-b | " +
          "severity_threshold=important | cost_rates=deepseek/model-b=1:2 | max_cost_usd=0.3 | " +
          "ignore_paths=docs/** | instructions=1",
      );

      process.env.GITHUB_EVENT_NAME = "pull_request";
      expect(formatConfigAuditLog(".elek.yml", { ignorePaths: [], instructions: [] })).toContain(
        "source=checked-out-pr-branch",
      );

      expect(formatConfigAuditLog("off", { ignorePaths: [], instructions: [] })).toContain(
        "path=(disabled)",
      );

      expect(formatConfigAuditLog(".elek.yml", { ignorePaths: [], instructions: [] }, {
        ...baseInputs,
        reviewStrategy: "council",
        reviewModels: "openrouter/model-a",
        validatorModel: "deepseek/model-b",
        severityThreshold: "critical",
        costRates: "deepseek/model-b=1:2",
        maxCostUsd: 0.3,
      })).toContain(
        "effective_review_strategy=council | effective_review_models=openrouter/model-a | " +
          "effective_validator_model=deepseek/model-b | effective_severity_threshold=critical | " +
          "effective_cost_rates=deepseek/model-b=1:2 | effective_max_cost_usd=0.3",
      );
    } finally {
      if (previousEvent === undefined) {
        delete process.env.GITHUB_EVENT_NAME;
      } else {
        process.env.GITHUB_EVENT_NAME = previousEvent;
      }
    }
  });
});
