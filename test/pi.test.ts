import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __buildPiEnv, buildPiArgs, runPi } from "../src/pi";
import type { ActionInputs } from "../src/types";

const baseInputs: ActionInputs = {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  thinking: "medium",
  prompt: "",
  runTimeoutSeconds: 600,
  configPath: ".elek.yml",
  stickyComment: true,
  severityThreshold: "",
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
  it("selects a default model within the requested provider", () => {
    const args = buildPiArgs({ ...baseInputs, model: "" }, "/tmp/prompt.md");

    expect(args).toContain("--provider");
    expect(args).toContain("deepseek");
    expect(args[args.indexOf("--model") + 1]).toBe("deepseek/");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("-e");
    expect(args.join(" ")).toContain("src/pi-workspace-guard.ts");
    expect(args).not.toContain("--no-builtin-tools");
    expect(args.join(" ")).not.toContain("src/pi-readonly-tools.ts");
    expect(args).toContain("--tools");
  });

  it("keeps an undefined model within the requested provider", () => {
    const args = buildPiArgs(
      { ...baseInputs, model: undefined as unknown as string },
      "/tmp/prompt.md",
    );

    expect(args).toContain("--provider");
    expect(args[args.indexOf("--model") + 1]).toBe("deepseek/");
  });

  it("disables native MCP discovery and project approval", () => {
    const args = buildPiArgs(baseInputs, "/tmp/prompt.md");
    expect(args).toContain("--no-mcp");
    expect(args).toContain("--no-approve");
  });

  it("always runs the read-only tools behind the workspace guard", () => {
    const args = buildPiArgs(baseInputs, "/tmp/prompt.md");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    expect(args[args.indexOf("-e") + 1]).toEndWith("src/pi-workspace-guard.ts");
    expect(args).not.toContain("--system-prompt");
  });

  it("lets provider-qualified model specs route themselves", () => {
    const args = buildPiArgs(
      {
        ...baseInputs,
        provider: "openrouter",
        model: "openrouter/moonshotai/kimi-k2.7-code",
      },
      "/tmp/prompt.md",
    );

    expect(args).not.toContain("--provider");
    expect(args).toContain("--model");
    expect(args).toContain("openrouter/moonshotai/kimi-k2.7-code");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("-e");
    expect(args.join(" ")).toContain("src/pi-workspace-guard.ts");
    expect(args).not.toContain("--no-builtin-tools");
    expect(args.join(" ")).not.toContain("src/pi-readonly-tools.ts");
  });

  it("keeps the provider for native model ids that contain a slash", () => {
    const args = buildPiArgs(
      {
        ...baseInputs,
        provider: "together",
        model: "deepseek-ai/DeepSeek-V4-Pro-0813",
      },
      "/tmp/prompt.md",
    );

    expect(args).toContain("--provider");
    expect(args[args.indexOf("--provider") + 1]).toBe("together");
    expect(args[args.indexOf("--model") + 1]).toBe("deepseek-ai/DeepSeek-V4-Pro-0813");
  });

  it("passes max thinking to pi without reducing it", () => {
    const args = buildPiArgs({ ...baseInputs, thinking: "max" }, "/tmp/prompt.md");

    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("max");
  });

  it("appends Elek's noninteractive reviewer contract in review mode", () => {
    const args = buildPiArgs(baseInputs, "/tmp/prompt.md");
    const promptIndex = args.indexOf("--append-system-prompt");

    expect(promptIndex).toBeGreaterThan(-1);
    expect(args[promptIndex + 1]).toContain("noninteractive read-only CI");
    expect(args[promptIndex + 1]).toContain(
      "Use repository inspection tools only to resolve a specific uncertainty",
    );
  });
});

describe("buildPiEnv", () => {
  const secretVars = ["SECRET_SHOULD_NOT_LEAK", "MY_DEPLOY_KEY", "AWS_BILLING_TOKEN"];

  afterEach(() => {
    for (const v of secretVars) delete process.env[v];
    delete process.env.GITHUB_TOKEN;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("does not leak parent secrets or GITHUB_TOKEN into the child env", () => {
    for (const v of secretVars) process.env[v] = "leaked-value";
    process.env.GITHUB_TOKEN = "ghs_fake_token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";

    const env = __buildPiEnv();

    for (const v of secretVars) {
      expect(env[v]).toBeUndefined();
    }
    // The host owns GitHub delivery.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBeDefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fake");
    expect(env.PI_OFFLINE).toBe("1");

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("passes Together credentials to the review child env without leaking unrelated secrets", () => {
    process.env.TOGETHER_API_KEY = "together-fake-key";
    process.env.SECRET_SHOULD_NOT_LEAK = "leaked-value";

    const env = __buildPiEnv();

    expect(env.TOGETHER_API_KEY).toBe("together-fake-key");
    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
  });

  it("passes OpenCode credentials to the review child env for the opencode-go provider", () => {
    process.env.OPENCODE_API_KEY = "opencode-fake-key";
    process.env.SECRET_SHOULD_NOT_LEAK = "leaked-value";

    const env = __buildPiEnv();

    expect(env.OPENCODE_API_KEY).toBe("opencode-fake-key");
    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
  });

  it("maps the existing Google credential to Pi's Gemini environment variable", () => {
    process.env.GOOGLE_API_KEY = "legacy-google-key";
    expect(__buildPiEnv().GEMINI_API_KEY).toBe("legacy-google-key");
  });

  it("preserves an explicitly configured Gemini credential", () => {
    process.env.GOOGLE_API_KEY = "legacy-google-key";
    process.env.GEMINI_API_KEY = "native-gemini-key";
    expect(__buildPiEnv().GEMINI_API_KEY).toBe("native-gemini-key");
  });
});

describe("runPi", () => {
  it("uses provider-reported JSON usage when pi emits token counts", async () => {
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
        { promptName: "usage-test" },
      );

      expect(result.conclusion).toBe("success");
      expect(result.output).toBe("done");
      expect(result.usage).toEqual({ inputTokens: 1234, outputTokens: 56, estimated: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sums provider-reported tokens across model turns", async () => {
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
      const result = await runPi("review this change", baseInputs, undefined, { promptName: "turn-metrics-test" });

      expect(result.conclusion).toBe("success");
      expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 17, estimated: false });
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
        { promptName: "timeout-test" },
      );

      expect(result.conclusion).toBe("failure");
      expect(result.output).toBe("pi timed out after 1s");
      expect(result.errorKind).toBe("timeout");
      expect(progressEvents).toContain("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("estimates tokens from prompt and output when pi reports no usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-pi-estimate-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, [
      "#!/usr/bin/env bash",
      "cat <<'JSON'",
      "{\"type\":\"turn_start\"}",
      "{\"type\":\"agent_end\",\"messages\":[{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"12345678\"}],\"stopReason\":\"stop\"}]}",
      "JSON",
      "",
    ].join("\n"), "utf-8");
    chmodSync(fakePi, 0o755);
    process.env.PI_EXECUTABLE = fakePi;

    try {
      const result = await runPi("x".repeat(400), baseInputs, undefined, { promptName: "estimate-test" });

      expect(result.conclusion).toBe("success");
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 2, estimated: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
