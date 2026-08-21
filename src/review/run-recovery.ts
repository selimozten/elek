import type { PiRunResult, PiTurnMetric } from "../types.js";

const RECOVERABLE_PROVIDER_FAILURE =
  /(?:h2 protocol error|error reading a body from connection|ECONNRESET|ETIMEDOUT|UND_ERR_|fetch failed|socket hang up|connection reset|^pi exited with code 0$)/i;

export async function runPiWithTransientRecovery(
  run: (attempt: number) => Promise<PiRunResult>,
  warn: (message: string) => void = console.warn,
): Promise<PiRunResult> {
  const first = await run(0);
  if (first.conclusion === "success" || !RECOVERABLE_PROVIDER_FAILURE.test(first.output)) return first;

  warn(`[review-retry] recoverable provider failure; retrying once`);
  return mergeAttempts(first, await run(1));
}

export function reviewPromptForAttempt(prompt: string, attempt: number): string {
  if (attempt === 0) return prompt;
  const runId = (process.env.GITHUB_RUN_ID || "local").replace(/[^a-zA-Z0-9_.-]/g, "");
  return `${prompt}\n\n<provider_recovery run_id="${runId}">A prior provider attempt returned no usable final response. Return the final review now.</provider_recovery>`;
}

function mergeAttempts(first: PiRunResult, second: PiRunResult): PiRunResult {
  return {
    ...second,
    turnsUsed: first.turnsUsed + second.turnsUsed,
    toolCalls: (first.toolCalls ?? 0) + (second.toolCalls ?? 0),
    turnMetrics: mergeTurnMetrics(first, second),
    providerRetries: first.providerRetries + second.providerRetries + 1,
    durationSeconds: first.durationSeconds + second.durationSeconds,
    costUsd: first.costUsd + second.costUsd,
    usage: {
      ...second.usage,
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      cacheReadTokens: (first.usage.cacheReadTokens ?? 0) + (second.usage.cacheReadTokens ?? 0),
      cacheWriteTokens: (first.usage.cacheWriteTokens ?? 0) + (second.usage.cacheWriteTokens ?? 0),
      reasoningTokens: sumOptional(
        first.usage.reasoningTokens,
        second.usage.reasoningTokens,
      ),
      estimated: first.usage.estimated || second.usage.estimated,
    },
  };
}

function mergeTurnMetrics(first: PiRunResult, second: PiRunResult): PiTurnMetric[] | undefined {
  const metrics = [
    ...(first.turnMetrics ?? []),
    ...(second.turnMetrics ?? []).map((metric) => ({
      ...metric,
      turn: metric.turn + first.turnsUsed,
    })),
  ];
  return metrics.length > 0 ? metrics : undefined;
}

function sumOptional(first: number | undefined, second: number | undefined): number | undefined {
  return first === undefined && second === undefined
    ? undefined
    : (first ?? 0) + (second ?? 0);
}
