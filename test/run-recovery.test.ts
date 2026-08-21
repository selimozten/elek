import { describe, expect, it } from "bun:test";
import { runPiWithTransientRecovery } from "../src/review/run-recovery";
import type { PiRunResult } from "../src/types";

function result(overrides: Partial<PiRunResult> = {}): PiRunResult {
  return {
    conclusion: "failure",
    output: "failed",
    turnsUsed: 1,
    toolCalls: 2,
    providerRetries: 0,
    durationSeconds: 3,
    costUsd: 0.01,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      reasoningTokens: 15,
      estimated: false,
      modelLabel: "together/deepseek-ai/DeepSeek-V4-Pro-0813",
      source: "provider",
    },
    ...overrides,
  };
}

describe("transient review recovery", () => {
  it("retries one HTTP/2 stream reset and aggregates both attempts", async () => {
    const attempts = [
      result({ output: "Stream error: h2 protocol error: error reading a body from connection" }),
      result({
        conclusion: "success",
        output: "Verdict: approve — no Blocker or Important findings",
        turnsUsed: 2,
        toolCalls: 1,
        durationSeconds: 4,
        costUsd: 0.02,
      }),
    ];
    let calls = 0;

    const recovered = await runPiWithTransientRecovery(async () => attempts[calls++]!);

    expect(calls).toBe(2);
    expect(recovered).toMatchObject({
      conclusion: "success",
      output: "Verdict: approve — no Blocker or Important findings",
      turnsUsed: 3,
      toolCalls: 3,
      providerRetries: 1,
      durationSeconds: 7,
      costUsd: 0.03,
      usage: {
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 20,
        reasoningTokens: 30,
      },
    });
  });

  it("does not retry model, policy, timeout, or turn-limit failures", async () => {
    for (const output of [
      "pi timed out after 600s",
      "pi exceeded max turns (20)",
      "Required review lanes failed: design",
      "Unauthorized",
    ]) {
      let calls = 0;
      const failed = await runPiWithTransientRecovery(async () => {
        calls++;
        return result({ output });
      });

      expect(calls).toBe(1);
      expect(failed.output).toBe(output);
    }
  });
});
