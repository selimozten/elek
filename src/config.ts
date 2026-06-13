import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
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

const ARRAY_KEYS = new Set<keyof ElekConfig>(["ignorePaths", "instructions"]);
const SEVERITIES = new Set(["critical", "important", "minor"]);

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if ((char === `"` || char === "'") && line[i - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (char === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function listValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => scalar(item))
      .filter(Boolean);
  }
  return [scalar(trimmed)];
}

export function parseElekConfig(text: string, warn: (message: string) => void = () => {}): ElekConfig {
  const config: ElekConfig = { ignorePaths: [], instructions: [] };
  let currentArrayKey: keyof ElekConfig | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trimEnd();
    if (!line.trim()) continue;

    const item = line.match(/^\s*-\s+(.+)$/);
    if (item) {
      if (!currentArrayKey || !ARRAY_KEYS.has(currentArrayKey)) {
        warn(`Ignoring config list item without a list key: ${line.trim()}`);
        continue;
      }
      (config[currentArrayKey] as string[]).push(scalar(item[1]));
      continue;
    }

    const kv = line.match(/^([A-Za-z_]+):(?:\s*(.*))?$/);
    if (!kv) {
      warn(`Ignoring unsupported config line: ${line.trim()}`);
      currentArrayKey = null;
      continue;
    }

    const key = KEY_MAP[kv[1]];
    if (!key) {
      warn(`Ignoring unknown config key: ${kv[1]}`);
      currentArrayKey = null;
      continue;
    }

    const value = kv[2] ?? "";
    if (ARRAY_KEYS.has(key)) {
      const items = listValue(value);
      if (items.length > 0) (config[key] as string[]).push(...items);
      currentArrayKey = key;
      continue;
    }

    currentArrayKey = null;
    const parsed = scalar(value);
    if (!parsed) continue;

    if (key === "severityThreshold") {
      const normalized = parsed.toLowerCase();
      if (!SEVERITIES.has(normalized)) {
        warn(`Ignoring invalid severity_threshold: ${parsed}`);
        continue;
      }
      config.severityThreshold = normalized as ElekConfig["severityThreshold"];
      continue;
    }

    (config[key] as string | undefined) = parsed;
  }

  return config;
}

export function loadElekConfig(path: string, warn: (message: string) => void = () => {}): ElekConfig {
  const trimmed = path.trim();
  if (!trimmed || ["none", "off", "false"].includes(trimmed.toLowerCase())) {
    return { ignorePaths: [], instructions: [] };
  }

  const resolved = resolve(process.cwd(), trimmed);
  if (!existsSync(resolved)) return { ignorePaths: [], instructions: [] };

  return parseElekConfig(readFileSync(resolved, "utf-8"), warn);
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
