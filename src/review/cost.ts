import type { ActionInputs, PiRunResult } from "../types";

export interface ModelRates {
  inputPerMillion: number;
  outputPerMillion: number;
  source: "builtin" | "override" | "provider" | "unknown";
}

export interface ReviewCost {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimated: boolean;
  modelLabel: string;
  source: ModelRates["source"];
}

export interface ReviewCostTotal {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimated: boolean;
  runs: ReviewCost[];
}

const BUILTIN_RATES: Record<string, Omit<ModelRates, "source">> = {
  "deepseek/deepseek-v4-pro": { inputPerMillion: 0.435, outputPerMillion: 0.87 },
  "openrouter/deepseek/deepseek-v4-pro": { inputPerMillion: 0.435, outputPerMillion: 0.87 },
  "openrouter/moonshotai/kimi-k2.7-code": { inputPerMillion: 0.95, outputPerMillion: 4 },
  "together/moonshotai/kimi-k2.7-code": { inputPerMillion: 0.95, outputPerMillion: 4 },
  "together/deepseek-ai/deepseek-v4-pro": { inputPerMillion: 2.1, outputPerMillion: 4.4 },
  "together/qwen/qwen3.7-max": { inputPerMillion: 1.25, outputPerMillion: 3.75 },
  "openai/gpt-5.5": { inputPerMillion: 5, outputPerMillion: 30 },
};
const overrideCache = new Map<string, Record<string, Omit<ModelRates, "source">>>();

export function modelLabelFor(inputs: Pick<ActionInputs, "provider" | "model">): string {
  if (!inputs.model) return inputs.provider;
  if (inputs.model === inputs.provider || inputs.model.startsWith(`${inputs.provider}/`)) {
    return inputs.model;
  }
  return `${inputs.provider}/${inputs.model}`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function parseCostRateOverrides(
  value: string,
  onInvalid?: (entry: string, reason: string) => void,
): Record<string, Omit<ModelRates, "source">> {
  const rates: Record<string, Omit<ModelRates, "source">> = {};
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const eq = entry.indexOf("=");
    if (eq < 0) {
      onInvalid?.(entry, "missing model=price pair");
      continue;
    }

    const label = entry.slice(0, eq).trim().toLowerCase();
    const priceParts = entry.slice(eq + 1).split(":");
    if (priceParts.length !== 2) {
      onInvalid?.(entry, "prices must be exactly input:output");
      continue;
    }
    const [inputRaw, outputRaw] = priceParts;
    if (!inputRaw?.trim() || !outputRaw?.trim()) {
      onInvalid?.(entry, "prices must include both input and output values");
      continue;
    }
    const inputPerMillion = Number(inputRaw);
    const outputPerMillion = Number(outputRaw);
    if (!label) {
      onInvalid?.(entry, "empty model label");
      continue;
    }
    if (!Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) {
      onInvalid?.(entry, "prices must be numeric input:output values");
      continue;
    }
    if (inputPerMillion < 0 || outputPerMillion < 0) {
      onInvalid?.(entry, "prices must be zero or positive");
      continue;
    }

    rates[label] = { inputPerMillion, outputPerMillion };
  }
  return rates;
}

export function resolveRates(modelLabel: string, overrides: string): ModelRates {
  const normalized = modelLabel.toLowerCase();
  let parsedOverrides = overrideCache.get(overrides);
  if (!parsedOverrides) {
    parsedOverrides = parseCostRateOverrides(overrides, (entry, reason) => {
      console.warn(`Ignoring invalid cost_rates entry "${entry}": ${reason}`);
    });
    overrideCache.set(overrides, parsedOverrides);
  }

  const override = parsedOverrides[normalized];
  if (override) return { ...override, source: "override" };

  const builtin = BUILTIN_RATES[normalized];
  if (builtin) return { ...builtin, source: "builtin" };

  return { inputPerMillion: 0, outputPerMillion: 0, source: "unknown" };
}

export function estimateRunCost(args: {
  modelLabel: string;
  prompt: string;
  output: string;
  costRates: string;
}): ReviewCost {
  const inputTokens = estimateTokens(args.prompt);
  const outputTokens = estimateTokens(args.output);
  const rates = resolveRates(args.modelLabel, args.costRates);
  const costUsd =
    (inputTokens / 1_000_000) * rates.inputPerMillion +
    (outputTokens / 1_000_000) * rates.outputPerMillion;

  return {
    inputTokens,
    outputTokens,
    costUsd,
    estimated: true,
    modelLabel: args.modelLabel,
    source: rates.source,
  };
}

export function aggregateCosts(runs: ReviewCost[]): ReviewCostTotal {
  return runs.reduce<ReviewCostTotal>(
    (total, run) => {
      total.inputTokens += run.inputTokens;
      total.outputTokens += run.outputTokens;
      total.costUsd += run.costUsd;
      total.estimated = total.estimated || run.estimated || run.source === "unknown";
      total.runs.push(run);
      return total;
    },
    { inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false, runs: [] },
  );
}

export function costFromPiResult(result: PiRunResult): ReviewCost {
  return {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.costUsd,
    estimated: result.usage.estimated,
    modelLabel: result.usage.modelLabel,
    source: result.usage.source,
  };
}

export function formatUsd(costUsd: number): string {
  const safeCost = Math.max(0, costUsd);
  if (safeCost === 0) return "$0.0000";
  if (safeCost < 0.0001) return "<$0.0001";
  return `$${safeCost.toFixed(4)}`;
}

export function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

export function formatCostLine(total: ReviewCostTotal): string {
  const prefix = total.estimated ? "Estimated review cost" : "Review cost";
  return `${prefix}: ${formatUsd(total.costUsd)} (${formatTokenCount(total.inputTokens)} in / ${formatTokenCount(total.outputTokens)} out tokens)`;
}

export function estimatePromptOnlyCost(args: {
  modelLabel: string;
  prompt: string;
  costRates: string;
}): ReviewCost {
  return estimateRunCost({
    modelLabel: args.modelLabel,
    prompt: args.prompt,
    output: "",
    costRates: args.costRates,
  });
}
