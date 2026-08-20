import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __buildPiEnv, buildPiArgs, runPi } from "../src/pi";
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
  reviewAgentCount: undefined,
  validatorModel: "",
  validatorThinking: "",
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
    expect(args).toContain("--no-builtin-tools");
    expect(args.join(" ")).toContain("src/pi-readonly-tools.ts");
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
    expect(args).toContain("--no-extensions");
    expect(args).toContain("-e");
    expect(args).toContain("--no-builtin-tools");
    expect(args.join(" ")).toContain("src/pi-readonly-tools.ts");
    expect(args.join(" ")).toContain("node_modules/pi-mcp-adapter");
  });

  it("passes max thinking to pi without reducing it", () => {
    const args = buildPiArgs({ ...baseInputs, thinking: "max" }, "/tmp/prompt.md", false);

    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("max");
  });

  it("appends Elek's noninteractive reviewer contract in review mode", () => {
    const args = buildPiArgs(baseInputs, "/tmp/prompt.md", false);
    const promptIndex = args.indexOf("--append-system-prompt");

    expect(promptIndex).toBeGreaterThan(-1);
    expect(args[promptIndex + 1]).toContain("noninteractive read-only CI");
    expect(args[promptIndex + 1]).toContain(
      "Use repository inspection tools only to resolve a specific uncertainty",
    );
  });

  it("does not impose the reviewer contract on legacy agent mode", () => {
    const args = buildPiArgs(
      { ...baseInputs, mode: "agent" },
      "/tmp/prompt.md",
      false,
    );

    expect(args).not.toContain("--append-system-prompt");
  });
});

describe("buildPiEnv", () => {
  const secretVars = ["SECRET_SHOULD_NOT_LEAK", "MY_DEPLOY_KEY", "AWS_BILLING_TOKEN"];

  afterEach(() => {
    for (const v of secretVars) delete process.env[v];
    delete process.env.GITHUB_TOKEN;
    delete process.env.TOGETHER_API_KEY;
  });

  it("does not leak arbitrary parent secrets into agent-mode child env", () => {
    for (const v of secretVars) process.env[v] = "leaked-value";
    process.env.GITHUB_TOKEN = "ghs_fake_token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";

    const env = __buildPiEnv({ ...baseInputs, provider: "anthropic", mode: "agent" });

    for (const v of secretVars) {
      expect(env[v]).toBeUndefined();
    }
    // But the vars agent mode legitimately needs are still present.
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBeDefined();
    expect(env.GITHUB_TOKEN).toBe("ghs_fake_token");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fake");
    expect(env.PI_OFFLINE).toBe("1");

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("review mode does not leak secrets and omits GITHUB_TOKEN", () => {
    process.env.SECRET_SHOULD_NOT_LEAK = "leaked-value";
    process.env.GITHUB_TOKEN = "ghs_fake_token";

    const env = __buildPiEnv({ ...baseInputs, mode: "review" });

    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
    // GITHUB_TOKEN is granted to review mode only when the MCP proxy is enabled.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("review mode passes GITHUB_TOKEN only when MCP is enabled", () => {
    process.env.GITHUB_TOKEN = "ghs_fake_token";

    const env = __buildPiEnv({ ...baseInputs, mode: "review", tools: "read,grep,find,ls,mcp" });

    expect(env.GITHUB_TOKEN).toBe("ghs_fake_token");
  });

  it("passes Together credentials to the review child env without leaking unrelated secrets", () => {
    process.env.TOGETHER_API_KEY = "together-fake-key";
    process.env.SECRET_SHOULD_NOT_LEAK = "leaked-value";

    const env = __buildPiEnv({ ...baseInputs, provider: "together", mode: "review" });

    expect(env.TOGETHER_API_KEY).toBe("together-fake-key");
    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
  });
});

describe("runPi", () => {
  it("uses provider-reported JSON usage when pi emits exact token and cost data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-pi-usage-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, [
      "#!/usr/bin/env bash",
      "cat <<'JSON'",
      "{\"type\":\"session\",\"id\":\"session-1\"}",
      "{\"type\":\"turn_start\"}",
      "{\"type\":\"auto_retry_start\",\"attempt\":1,\"maxAttempts\":3,\"delayMs\":1000,\"errorMessage\":\"rate limited\"}",
      "{\"type\":\"auto_retry_end\",\"success\":true,\"attempt\":1}",
      "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":1234,\"output\":56,\"cost\":{\"total\":0.00789}},\"stopReason\":\"stop\"}}",
      "{\"type\":\"agent_end\",\"messages\":[{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":1234,\"output\":56,\"cost\":{\"total\":0.00789}},\"stopReason\":\"stop\"}]}",
      "JSON",
      "",
    ].join("\n"), "utf-8");
    chmodSync(fakePi, 0o755);
    process.env.PI_EXECUTABLE = fakePi;

    try {
      const result = await runPi(
        "review this change",
        { ...baseInputs, provider: "together", model: "together/moonshotai/Kimi-K2.7-Code" },
        undefined,
        false,
        { promptName: "usage-test" },
      );

      expect(result.conclusion).toBe("success");
      expect(result.output).toBe("done");
      expect(result.usage).toMatchObject({
        inputTokens: 1234,
        outputTokens: 56,
        estimated: false,
        modelLabel: "together/moonshotai/Kimi-K2.7-Code",
        source: "provider",
      });
      expect(result.providerRetries).toBe(1);
      expect(result.costUsd).toBe(0.00789);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records prompt settings and exact usage for every model turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-pi-turn-metrics-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, [
      "#!/usr/bin/env bash",
      "cat <<'JSON'",
      "{\"type\":\"session\",\"id\":\"session-turn-metrics\"}",
      "{\"type\":\"turn_start\"}",
      "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"toolName\":\"read\"}],\"usage\":{\"input\":100,\"output\":10,\"cacheRead\":80,\"cacheWrite\":2,\"reasoning\":5,\"totalTokens\":192,\"cost\":{\"total\":0.001}},\"stopReason\":\"toolUse\"}}",
      "{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"toolName\":\"read\"}],\"usage\":{\"input\":100,\"output\":10,\"cacheRead\":80,\"cacheWrite\":2,\"reasoning\":5,\"totalTokens\":192,\"cost\":{\"total\":0.001}},\"stopReason\":\"toolUse\"},\"toolResults\":[]}",
      "{\"type\":\"turn_start\"}",
      "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":20,\"output\":7,\"cacheRead\":160,\"cacheWrite\":0,\"reasoning\":3,\"totalTokens\":187,\"cost\":{\"total\":0.002}},\"stopReason\":\"stop\"}}",
      "{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":20,\"output\":7,\"cacheRead\":160,\"cacheWrite\":0,\"reasoning\":3,\"totalTokens\":187,\"cost\":{\"total\":0.002}},\"stopReason\":\"stop\"},\"toolResults\":[]}",
      "{\"type\":\"agent_end\",\"messages\":[{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"usage\":{\"input\":20,\"output\":7,\"cacheRead\":160,\"cacheWrite\":0,\"reasoning\":3,\"totalTokens\":187,\"cost\":{\"total\":0.002}},\"stopReason\":\"stop\"}]}",
      "JSON",
      "",
    ].join("\n"), "utf-8");
    chmodSync(fakePi, 0o755);
    process.env.PI_EXECUTABLE = fakePi;

    try {
      const prompt = "review this change";
      const result = await runPi(prompt, baseInputs, undefined, false, { promptName: "turn-metrics-test" });

      expect(result.conclusion).toBe("success");
      expect(result.promptChars).toBe(prompt.length);
      expect(result.thinking).toBe("medium");
      expect(result.turnsUsed).toBe(2);
      expect(result.turnMetrics).toHaveLength(2);
      expect(result.turnMetrics[0]).toMatchObject({
        turn: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 80,
        cacheWriteTokens: 2,
        reasoningTokens: 5,
        totalTokens: 192,
        stopReason: "toolUse",
      });
      expect(result.usage).toMatchObject({
        inputTokens: 120,
        outputTokens: 17,
        cacheReadTokens: 240,
        cacheWriteTokens: 2,
        reasoningTokens: 8,
      });
      expect(result.costUsd).toBe(0.003);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("terminates a run when pi starts more than maxTurns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-pi-turn-limit-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, [
      "#!/usr/bin/env node",
      "process.on('SIGTERM', () => process.exit(0));",
      "console.log(JSON.stringify({ type: 'session', id: 'session-turn-limit' }));",
      "console.log(JSON.stringify({ type: 'turn_start' }));",
      "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'premature output' }], stopReason: 'stop' } }));",
      "console.log(JSON.stringify({ type: 'turn_start' }));",
      "console.log(JSON.stringify({ type: 'turn_start' }));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"), "utf-8");
    chmodSync(fakePi, 0o755);
    process.env.PI_EXECUTABLE = fakePi;

    try {
      const result = await runPi(
        "review this change",
        { ...baseInputs, maxTurns: 2, runTimeoutSeconds: 10 },
        undefined,
        false,
        { promptName: "turn-limit-test" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.output).toBe("pi exceeded max turns (2)");
      expect(result.turnsUsed).toBe(3);
      expect(result.durationSeconds).toBeLessThan(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
