import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildPiArgs, runPi } from "../src/pi";
import type { ActionInputs } from "../src/types";

const baseInputs: ActionInputs = {
  triggerPhrase: "@pi",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  thinking: "medium",
  prompt: "",
  systemPrompt: "",
  maxTurns: 20,
  runTimeoutSeconds: 600,
  tools: "read,grep,find,ls",
  configPath: ".elek.yml",
  branchPrefix: "elek/",
  actorFilter: "",
  allowedBots: "",
  stickyComment: true,
  mode: "review",
  reviewStrategy: "solo",
  reviewModels: "",
  validatorModel: "",
  severityThreshold: "",
  showCost: true,
  costRates: "",
};

const originalPiExecutable = process.env.PI_EXECUTABLE;

afterEach(() => {
  if (originalPiExecutable === undefined) {
    delete process.env.PI_EXECUTABLE;
  } else {
    process.env.PI_EXECUTABLE = originalPiExecutable;
  }
});

describe("buildPiArgs", () => {
  it("omits --model when the provider default model is requested", () => {
    const args = buildPiArgs({ ...baseInputs, model: "" }, "/tmp/prompt.md", false);

    expect(args).toContain("--provider");
    expect(args).toContain("deepseek");
    expect(args).not.toContain("--model");
    expect(args).toContain("--no-extensions");
  });

  it("defensively omits --model when model is undefined", () => {
    const args = buildPiArgs(
      { ...baseInputs, model: undefined as unknown as string },
      "/tmp/prompt.md",
      false,
    );

    expect(args).toContain("--provider");
    expect(args).not.toContain("--model");
  });

  it("lets provider-qualified model specs route themselves", () => {
    const args = buildPiArgs(
      {
        ...baseInputs,
        provider: "openrouter",
        model: "openrouter/moonshotai/kimi-k2.7-code",
      },
      "/tmp/prompt.md",
      true,
    );

    expect(args).not.toContain("--provider");
    expect(args).toContain("--model");
    expect(args).toContain("openrouter/moonshotai/kimi-k2.7-code");
    expect(args).not.toContain("--no-extensions");
  });
});

describe("runPi", () => {
  it("returns a failure result when pi exceeds the configured timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-pi-timeout-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, "#!/usr/bin/env bash\nsleep 10\n", "utf-8");
    chmodSync(fakePi, 0o755);
    process.env.PI_EXECUTABLE = fakePi;

    try {
      const progressEvents: string[] = [];
      const result = await runPi(
        "review this change",
        { ...baseInputs, runTimeoutSeconds: 1 },
        async (event) => {
          progressEvents.push(event.type);
        },
        false,
        { promptName: "timeout-test" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.output).toBe("pi timed out after 1s");
      expect(result.durationSeconds).toBeGreaterThanOrEqual(1);
      expect(progressEvents).toContain("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
