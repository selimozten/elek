import { readFileSync, realpathSync, statSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import { execFileSync } from "child_process";
import { parse as parseYaml } from "yaml";
import type { ActionInputs } from "./types.js";

export interface ElekConfig {
  reviewStrategy?: string;
  reviewModels?: string;
  validatorModel?: string;
  costRates?: string;
  severityThreshold?: "critical" | "important" | "minor";
  ignorePaths: string[];
  instructions: string[];
}

export interface ElekConfigLoadResult {
  config: ElekConfig;
  loaded: boolean;
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
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PROMPT_LIST_ITEMS = 50;
const MAX_PROMPT_ENTRY_CHARS = 500;
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
  if (!scalar && value != null && typeof value !== "string") {
    warn(`Ignoring non-scalar ${key} value`);
  }
  return scalar ? [scalar] : [];
}

function boundedPromptList(items: string[], key: string, warn: (message: string) => void): string[] {
  const bounded = items.slice(0, MAX_PROMPT_LIST_ITEMS).map((item) => {
    if (item.length <= MAX_PROMPT_ENTRY_CHARS) return item;
    warn(`Truncating ${key} item longer than ${MAX_PROMPT_ENTRY_CHARS} characters`);
    return item.slice(0, MAX_PROMPT_ENTRY_CHARS);
  });
  if (items.length > MAX_PROMPT_LIST_ITEMS) {
    warn(`Ignoring ${items.length - MAX_PROMPT_LIST_ITEMS} excess ${key} items`);
  }
  return bounded;
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
  const scalar = stringValue(value);
  if (!scalar && value != null && typeof value !== "string") {
    warn(`Ignoring non-scalar ${key} value`);
  }
  return scalar;
}

function promptText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
        config[key] = boundedPromptList(stringList(value, rawKey, warn), rawKey, warn);
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
        break;
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
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      warn(`Config path is not a file: ${trimmed}`);
      return emptyConfig();
    }
    if (stat.size > MAX_CONFIG_BYTES) {
      warn(`Config file is too large: ${trimmed}`);
      return emptyConfig();
    }
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
    warn(`Could not read config file ${trimmed}: ${(err as Error).message}`);
    return emptyConfig();
  }
}

function normalizeBaseRef(baseRef: string): string | undefined {
  const shortRef = baseRef.startsWith("refs/heads/") ? baseRef.slice("refs/heads/".length) : baseRef;
  if (
    !shortRef ||
    shortRef.startsWith("-") ||
    shortRef.startsWith(".") ||
    shortRef.includes("..") ||
    shortRef.split(/[\\/]+/).includes("..") ||
    !/^[A-Za-z0-9_./-]+$/.test(shortRef)
  ) {
    return undefined;
  }
  return shortRef;
}

function repoLocalConfigPath(path: string, warn: (message: string) => void): string | undefined {
  const trimmed = path.trim();
  if (!isAbsolute(trimmed)) return trimmed;

  let root: string;
  try {
    root = realpathSync(resolve(process.env.GITHUB_WORKSPACE || process.cwd()));
  } catch (err) {
    warn(`Workspace path not resolvable: ${(err as Error).message}`);
    return undefined;
  }

  const resolved = resolve(trimmed);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    warn(`Config path resolves outside the workspace: ${trimmed}`);
    return undefined;
  }
  const repoPath = relative(root, resolved);
  return repoPath || undefined;
}

export function loadBaseBranchElekConfig(
  path: string,
  baseRef: string | undefined,
  warn: (message: string) => void = () => {},
): ElekConfigLoadResult {
  const trimmed = path.trim();
  if (!baseRef || !trimmed || ["none", "off", "false"].includes(trimmed.toLowerCase())) {
    return { config: emptyConfig(), loaded: false };
  }
  const repoPath = repoLocalConfigPath(trimmed, warn);
  if (!repoPath) {
    return { config: emptyConfig(), loaded: false };
  }
  if (repoPath.split(/[\\/]+/).includes("..")) {
    warn(`Config path is not repo-local: ${trimmed}`);
    return { config: emptyConfig(), loaded: false };
  }

  const shortBaseRef = normalizeBaseRef(baseRef);
  if (!shortBaseRef) {
    warn(`Base ref is not safe for config loading: ${baseRef}`);
    return { config: emptyConfig(), loaded: false };
  }
  const remoteRef = `origin/${shortBaseRef}`;

  const gitCwd = process.env.GITHUB_WORKSPACE || process.cwd();
  try {
    execFileSync("git", ["rev-parse", "--verify", remoteRef], {
      cwd: gitCwd,
      stdio: "ignore",
    });
  } catch {
    try {
      execFileSync("git", ["fetch", "origin", shortBaseRef, "--depth=1"], {
        cwd: gitCwd,
        stdio: "ignore",
      });
    } catch (err) {
      warn(`Could not fetch base branch config source ${baseRef}: ${(err as Error).message}`);
      return { config: emptyConfig(), loaded: false };
    }
  }

  try {
    const text = execFileSync("git", ["show", `${remoteRef}:${repoPath}`], {
      cwd: gitCwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_CONFIG_BYTES + 1,
    });
    if (Buffer.byteLength(text, "utf-8") > MAX_CONFIG_BYTES) {
      warn(`Base branch config file is too large: ${repoPath}`);
      return { config: emptyConfig(), loaded: false };
    }
    return { config: parseElekConfig(text, warn, { throwOnParseError: true }), loaded: true };
  } catch (err) {
    if (err instanceof ElekConfigParseError) throw err;
    warn(`Could not load base branch config from ${repoPath} on ${baseRef}: ${(err as Error).message}`);
    return { config: emptyConfig(), loaded: false };
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
    severityThreshold:
      !inputs.severityThreshold && config.severityThreshold ? config.severityThreshold : inputs.severityThreshold,
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
    "[config] audit",
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
    fields.push(`effective_severity_threshold=${effective.severityThreshold || "(unset)"}`);
    fields.push(`effective_cost_rates=${effective.costRates || "(unset)"}`);
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
    lines.push(...config.ignorePaths.map((path) => `- ${promptText(path)}`));
    lines.push("Skip findings whose evidence is entirely within ignored paths. Still surface findings in ignored paths if they cause a security or runtime issue elsewhere in the codebase.");
  }
  if (config.instructions.length > 0) {
    lines.push("instructions:");
    lines.push(...config.instructions.map((instruction) => `- ${promptText(instruction)}`));
  }
  return lines;
}
