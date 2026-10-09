import { afterEach, describe, expect, it } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const runtimeDirs: string[] = [];
afterEach(() => {
  for (const dir of runtimeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createRuntime(modelsPath: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "elek-model-registry-"));
  runtimeDirs.push(dir);
  return ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath,
    modelsStorePath: join(dir, "models-store.json"),
  });
}

describe("bundled pi model registry", () => {
  it("contains native Together metadata for the production review models", async () => {
    const runtime = await createRuntime(null);

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

  it("uses the native Together capabilities for DeepSeek V4 Pro", async () => {
    const runtime = await createRuntime(resolve("pi-config/models.json"));

    const model = runtime.getModel("together", "deepseek-ai/DeepSeek-V4-Pro-0813");
    expect(model).toMatchObject({
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      cost: {
        input: 1.32,
        output: 3.96,
        cacheRead: 0.13,
      },
      compat: {
        supportsReasoningEffort: false,
      },
    });
    expect(model?.samplingParams).toBeUndefined();
    expect(model?.thinkingLevelMap?.max).toBeUndefined();
  });

  it("does not override native Pi retry or timeout settings", () => {
    expect(existsSync(resolve("pi-config/settings.json"))).toBe(false);
  });
});
