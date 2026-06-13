import { existsSync, readFileSync, realpathSync } from "fs";
import { resolve, sep } from "path";
import { execFileSync } from "child_process";
import { parse as parseYaml } from "yaml";
import type { ActionInputs } from "./types";

export interface ElekConfig {
  reviewStrategy?: string;
  reviewModels?: string;
  validatorModel?: string;
  costRates?: string;
  severityThreshold?: "critical" | "important" | "minor";
  ignorePaths: string[];
  instructions: string[];
}

export class ElekConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElekConfigParseError";
  }
}

const KEY_MAP: Record<string, keyof ElekConfig> = {
  review_strategy: "reviewStrategy",
  review_models: "reviewModels",
  validator_model: "validatorModel",
  cost_rates: "costRates",
  severity_threshold: "severityThreshold",
  ignore_paths: "ignorePaths",
  instructions: "instructions",
};

const SEVERITIES = new Set(["critical", "important", "minor"]);
const REVIEW_STRATEGY_ALIASES: Record<string, string> = {
  solo: "solo",
  crosscheck: "crosscheck",
  "cross-check": "crosscheck",
  dual: "crosscheck",
  duo: "crosscheck",
  council: "council",
  swarm: "council",
  panel: "council",
};

export function normalizeReviewStrategy(raw: string | undefined): string | undefined {
  const strategy = raw?.trim().toLowerCase();
  return strategy ? REVIEW_STRATEGY_ALIASES[strategy] : undefined;
}

function emptyConfig(): ElekConfig {
  return { ignorePaths: [], instructions: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function stringList(value: unknown, key: string, warn: (message: string) => void): string[] {
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const scalar = stringValue(item);
      if (scalar) {
        items.push(scalar);
      } else {
        warn(`Ignoring non-scalar ${key} item`);
      }
    }
    return items;
  }
  const scalar = stringValue(value);
  if (!scalar && value != null) warn(`Ignoring non-scalar ${key} value`);
  return scalar ? [scalar] : [];
}

function modelList(value: unknown, key: string, warn: (message: string) => void): string | undefined {
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const scalar = stringValue(item);
      if (scalar) {
        items.push(scalar);
      } else {
        warn(`Ignoring non-scalar ${key} item`);
      }
    }
    return items.length > 0 ? items.join(",") : undefined;
  }
  return stringValue(value);
}

export function parseElekConfig(
  text: string,
  warn: (message: string) => void = () => {},
  options: { throwOnParseError?: boolean } = {},
): ElekConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const message = `Could not parse config YAML: ${(err as Error).message}`;
    warn(message);
    if (options.throwOnParseError) throw new ElekConfigParseError(message);
    return emptyConfig();
  }

  if (doc == null) return emptyConfig();
  if (!isRecord(doc)) {
    warn("Ignoring config because the top-level YAML value is not a mapping");
    return emptyConfig();
  }

  const config = emptyConfig();
  for (const [rawKey, value] of Object.entries(doc)) {
    const key = KEY_MAP[rawKey];
    if (!key) {
      warn(`Ignoring unknown config key: ${rawKey}`);
      continue;
    }

    switch (key) {
      case "ignorePaths":
      case "instructions":
        config[key] = stringList(value, rawKey, warn);
        break;
      case "reviewModels":
        config.reviewModels = modelList(value, rawKey, warn);
        break;
      case "costRates":
        config.costRates = modelList(value, rawKey, warn);
        break;
      case "reviewStrategy": {
        const strategy = stringValue(value);
        if (!strategy) break;
        const canonical = normalizeReviewStrategy(strategy);
        if (!canonical) {
          warn(`Ignoring invalid review_strategy: ${strategy.toLowerCase()}`);
          break;
        }
        config.reviewStrategy = canonical;
        break;
      }
      case "severityThreshold": {
        const severity = stringValue(value)?.toLowerCase();
        if (!severity) break;
        if (!SEVERITIES.has(severity)) {
          warn(`Ignoring invalid severity_threshold: ${severity}`);
          break;
        }
        config.severityThreshold = severity as ElekConfig["severityThreshold"];
        break;
      }
      default: {
        const scalar = stringValue(value);
        if (scalar) {
          config[key] = scalar;
        } else if (value != null) {
          warn(`Ignoring non-scalar ${rawKey} value`);
        }
      }
    }
  }

  return config;
}

export function loadElekConfig(path: string, warn: (message: string) => void = () => {}): ElekConfig {
  const trimmed = path.trim();
  if (!trimmed || ["none", "off", "false"].includes(trimmed.toLowerCase())) {
    return emptyConfig();
  }

  let root: string;
  try {
    root = realpathSync(resolve(process.env.GITHUB_WORKSPACE || process.cwd()));
  } catch (err) {
    warn(`Workspace path not resolvable: ${(err as Error).message}`);
    return emptyConfig();
  }

  const resolved = resolve(root, trimmed);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    warn(`Config path resolves outside the workspace: ${trimmed}`);
    return emptyConfig();
  }
  if (!existsSync(resolved)) return emptyConfig();

  try {
    const realResolved = realpathSync(resolved);
    if (realResolved !== root && !realResolved.startsWith(root + sep)) {
      warn(`Config path resolves outside the workspace: ${trimmed}`);
      return emptyConfig();
    }
    return parseElekConfig(readFileSync(realResolved, "utf-8"), warn, {
      throwOnParseError: true,
    });
  } catch (err) {
    if (err instanceof ElekConfigParseError) throw err;
    warn(`Could not read config file ${trimmed}: ${(err as Error).message}`);
    return emptyConfig();
  }
}

export function loadBaseBranchElekConfig(
  path: string,
  baseRef: string | undefined,
  warn: (message: string) => void = () => {},
): ElekConfig {
  const trimmed = path.trim();
  if (!baseRef || !trimmed || ["none", "off", "false"].includes(trimmed.toLowerCase())) {
    return emptyConfig();
  }
  if (trimmed.startsWith("/") || trimmed.split(/[\\/]+/).includes("..")) {
    warn(`Config path is not repo-local: ${trimmed}`);
    return emptyConfig();
  }

  try {
    execFileSync("git", ["fetch", "origin", baseRef, "--depth=1"], { stdio: "ignore" });
  } catch {
    warn(`Could not fetch base branch config source: ${baseRef}`);
    return emptyConfig();
  }

  try {
    const text = execFileSync("git", ["show", `origin/${baseRef}:${trimmed}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseElekConfig(text, warn, { throwOnParseError: true });
  } catch (err) {
    if (err instanceof ElekConfigParseError) throw err;
    return emptyConfig();
  }
}

export function mergeBasePolicyWithWorkspaceGuidance(
  basePolicy: ElekConfig,
  workspaceGuidance: ElekConfig,
): ElekConfig {
  return {
    reviewStrategy: basePolicy.reviewStrategy,
    reviewModels: basePolicy.reviewModels,
    validatorModel: basePolicy.validatorModel,
    costRates: basePolicy.costRates,
    severityThreshold: basePolicy.severityThreshold,
    ignorePaths: workspaceGuidance.ignorePaths,
    instructions: workspaceGuidance.instructions,
  };
}

export function applyConfigDefaults(inputs: ActionInputs, config: ElekConfig): ActionInputs {
  return {
    ...inputs,
    reviewStrategy:
      !inputs.reviewStrategy && config.reviewStrategy ? config.reviewStrategy : inputs.reviewStrategy,
    reviewModels:
      !inputs.reviewModels && config.reviewModels ? config.reviewModels : inputs.reviewModels,
    validatorModel:
      !inputs.validatorModel && config.validatorModel ? config.validatorModel : inputs.validatorModel,
    costRates: !inputs.costRates && config.costRates ? config.costRates : inputs.costRates,
  };
}

export function formatConfigAuditLog(
  path: string,
  config: ElekConfig,
  effective?: ActionInputs,
  sourceOverride?: string,
): string {
  const disabled = !path.trim() || ["none", "off", "false"].includes(path.trim().toLowerCase());
  const source = sourceOverride || (process.env.GITHUB_EVENT_NAME === "pull_request"
    ? "checked-out-pr-branch"
    : "checked-out-workspace");
  const fields = [
    "[config] loaded",
    `path=${disabled ? "(disabled)" : path}`,
    `source=${disabled ? "(disabled)" : source}`,
    `review_strategy=${config.reviewStrategy ?? "(unset)"}`,
    `review_models=${config.reviewModels ?? "(unset)"}`,
    `validator_model=${config.validatorModel ?? "(unset)"}`,
    `severity_threshold=${config.severityThreshold ?? "(unset)"}`,
    `cost_rates=${config.costRates ?? "(unset)"}`,
    `ignore_paths=${config.ignorePaths.length > 0 ? config.ignorePaths.join(",") : "(none)"}`,
    `instructions=${config.instructions.length}`,
  ];
  if (effective) {
    fields.push(`effective_review_strategy=${effective.reviewStrategy || "solo"}`);
    fields.push(`effective_review_models=${effective.reviewModels || "(primary model)"}`);
    fields.push(`effective_validator_model=${effective.validatorModel || "(primary model)"}`);
  }
  return fields.join(" | ");
}

export function formatConfigPromptBlock(config: ElekConfig): string[] {
  const lines: string[] = [];
  if (config.severityThreshold) {
    lines.push(`severity_threshold: ${config.severityThreshold}`);
    lines.push(`Only surface findings at or above ${config.severityThreshold} severity.`);
  }
  if (config.ignorePaths.length > 0) {
    lines.push("ignore_paths:");
    lines.push(...config.ignorePaths.map((path) => `- ${path}`));
    lines.push("Do not surface findings for ignored paths unless they create a security or runtime issue outside the ignored path.");
  }
  if (config.instructions.length > 0) {
    lines.push("instructions:");
    lines.push(...config.instructions.map((instruction) => `- ${instruction}`));
  }
  return lines;
}
