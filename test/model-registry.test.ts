import { describe, expect, it } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
});
