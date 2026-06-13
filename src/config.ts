import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
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

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => stringValue(item))
      .filter((item): item is string => !!item);
  }
  const scalar = stringValue(value);
  return scalar ? [scalar] : [];
}

function modelList(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items = stringList(value);
    return items.length > 0 ? items.join(",") : undefined;
  }
  return stringValue(value);
}

export function parseElekConfig(text: string, warn: (message: string) => void = () => {}): ElekConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    warn(`Could not parse config YAML: ${(err as Error).message}`);
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
        config[key] = stringList(value);
        break;
      case "reviewModels":
        config.reviewModels = modelList(value);
        break;
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
      default:
        config[key] = stringValue(value);
    }
  }

  return config;
}

export function loadElekConfig(path: string, warn: (message: string) => void = () => {}): ElekConfig {
  const trimmed = path.trim();
  if (!trimmed || ["none", "off", "false"].includes(trimmed.toLowerCase())) {
    return emptyConfig();
  }

  const resolved = resolve(process.cwd(), trimmed);
  if (!existsSync(resolved)) return emptyConfig();

  try {
    return parseElekConfig(readFileSync(resolved, "utf-8"), warn);
  } catch (err) {
    warn(`Could not read config file ${trimmed}: ${(err as Error).message}`);
    return emptyConfig();
  }
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
