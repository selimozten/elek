import { describe, expect, it } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("bundled pi model registry", () => {
  it("contains native Together metadata for the production review models", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(tmpdir(), `elek-model-registry-${randomUUID()}.json`),
      modelsPath: null,
    });

    expect(runtime.getModel("together", "moonshotai/Kimi-K3")).toMatchObject({
      id: "moonshotai/Kimi-K3",
      provider: "together",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
      },
    });

    expect(runtime.getModel("together", "zai-org/GLM-5.2")).toMatchObject({
      id: "zai-org/GLM-5.2",
      provider: "together",
      reasoning: true,
    });
  });

  it("enables Together max reasoning and caps DeepSeek V4 review output", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(tmpdir(), `elek-model-registry-${randomUUID()}.json`),
      modelsPath: resolve("pi-config/models.json"),
    });

    expect(runtime.getModel("together", "deepseek-ai/DeepSeek-V4-Flash-0731")).toMatchObject({
      thinkingLevelMap: {
        max: "max",
      },
      samplingParams: {
        max_tokens: 32_768,
      },
      compat: {
        supportsReasoningEffort: true,
      },
    });

    expect(runtime.getModel("together", "deepseek-ai/DeepSeek-V4-Pro-0813")).toMatchObject({
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 16_384,
      thinkingLevelMap: {
        high: "high",
        max: "max",
      },
      cost: {
        input: 1.32,
        output: 3.96,
        cacheRead: 0.13,
      },
      samplingParams: {
        max_tokens: 16_384,
      },
      compat: {
        supportsReasoningEffort: true,
      },
    });
  });

  it("retries stalled provider requests after ten minutes", () => {
    const settings = JSON.parse(readFileSync(resolve("pi-config/settings.json"), "utf8"));

    expect(settings).toMatchObject({
      retry: {
        enabled: true,
        maxRetries: 3,
        provider: {
          timeoutMs: 600_000,
          maxRetries: 0,
        },
      },
    });
  });
});
