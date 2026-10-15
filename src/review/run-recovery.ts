import type { PiRunResult } from "../types.js";

export async function runPiWithTransientRecovery(
  run: (attempt: number) => Promise<PiRunResult>,
  warn: (message: string) => void = console.warn,
): Promise<PiRunResult> {
  const first = await run(0);
  if (first.conclusion === "success" || first.errorKind !== "transport") return first;

  warn(`[review-retry] recoverable provider failure; retrying once`);
  const second = await run(1);
  return {
    ...second,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      estimated: first.usage.estimated || second.usage.estimated,
    },
  };
}

export function reviewPromptForAttempt(prompt: string, attempt: number): string {
  if (attempt === 0) return prompt;
  const runId = (process.env.GITHUB_RUN_ID || "local").replace(/[^a-zA-Z0-9_.-]/g, "");
  return `${prompt}\n\n<provider_recovery run_id="${runId}">A prior provider attempt returned no usable final response. Return the final review now.</provider_recovery>`;
}
