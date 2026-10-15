import type { ActionInputs, PiRunResult } from "../types";

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

export function formatTokenLine(usage: PiRunResult["usage"]): string {
  const counts =
    `${usage.inputTokens.toLocaleString("en-US")} in / ` +
    `${usage.outputTokens.toLocaleString("en-US")} out`;
  return `${usage.estimated ? "Estimated token usage" : "Token usage"}: ${counts}`;
}
