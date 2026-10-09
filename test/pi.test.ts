import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __buildPiEnv, buildPiArgs, runPi, type ProgressEvent } from "../src/pi";
import type { ActionInputs } from "../src/types";
import { writeReviewMcpConfig } from "../src/mcp/config";
import { resolveMode } from "../src/github/mode";

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
const originalGoogleKey = process.env.GOOGLE_API_KEY;
const originalGeminiKey = process.env.GEMINI_API_KEY;

afterEach(() => {
  if (originalPiExecutable === undefined) {
    delete process.env.PI_EXECUTABLE;
  } else {
    process.env.PI_EXECUTABLE = originalPiExecutable;
  }
});

describe("buildPiArgs", () => {
  it("uses an explicit provider with an empty model pattern when model is empty", () => {
    const args = buildPiArgs({ ...baseInputs, model: "" }, "/tmp/prompt.md", false);

    expect(args[args.indexOf("--provider") + 1]).toBe("deepseek");
    expect(args[args.indexOf("--model") + 1]).toBe("deepseek/");
    expect(args).not.toContain("--models");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-builtin-tools");
    expect(args.join(" ")).toContain("src/pi-readonly-tools.ts");
  });

  it("uses the provider's model pattern when model is undefined", () => {
    const args = buildPiArgs(
      { ...baseInputs, model: undefined as unknown as string },
      "/tmp/prompt.md",
      false,
    );

    expect(args[args.indexOf("--provider") + 1]).toBe("deepseek");
    expect(args[args.indexOf("--model") + 1]).toBe("deepseek/");
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
    expect(args).toContain("builtin:mcp");
    expect(args).not.toContain("--no-mcp");
    expect(args.join(" ")).not.toContain("pi-mcp-adapter");
  });

  it("disables MCP and project configuration for candidate reviewers and agent runs", () => {
    for (const mode of ["review", "agent"]) {
      const args = buildPiArgs({ ...baseInputs, mode }, "/tmp/prompt.md", false);
      expect(args).toContain("--no-mcp");
      expect(args).toContain("--no-approve");
      expect(args).not.toContain("builtin:mcp");
    }
  });

  it("passes max thinking through to Pi 1.0", () => {
    const args = buildPiArgs({ ...baseInputs, thinking: "max" }, "/tmp/prompt.md", false);

    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("max");
  });
});

describe("buildPiEnv", () => {
  const secretVars = ["SECRET_SHOULD_NOT_LEAK", "MY_DEPLOY_KEY", "AWS_BILLING_TOKEN"];

  afterEach(() => {
    for (const v of secretVars) delete process.env[v];
    delete process.env.GITHUB_TOKEN;
    delete process.env.TOGETHER_API_KEY;
    if (originalGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogleKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
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
    // Candidate reviewers never receive the posting token.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("review mode passes GITHUB_TOKEN only when MCP is enabled", () => {
    process.env.GITHUB_TOKEN = "ghs_fake_token";

    const env = __buildPiEnv(baseInputs, true, "/tmp/elek-pi-test");

    expect(env.GITHUB_TOKEN).toBe("ghs_fake_token");
    expect(env.PI_CODING_AGENT_DIR).toBe("/tmp/elek-pi-test");
  });

  it("does not grant the posting token just because MCP tool names appear in an allowlist", () => {
    process.env.GITHUB_TOKEN = "ghs_fake_token";
    const env = __buildPiEnv({
      ...baseInputs,
      tools: "read,mcp__elek_review__create_inline_comment",
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("passes Together credentials to the review child env without leaking unrelated secrets", () => {
    process.env.TOGETHER_API_KEY = "together-fake-key";
    process.env.SECRET_SHOULD_NOT_LEAK = "leaked-value";

    const env = __buildPiEnv({ ...baseInputs, provider: "together", mode: "review" });

    expect(env.TOGETHER_API_KEY).toBe("together-fake-key");
    expect(env.SECRET_SHOULD_NOT_LEAK).toBeUndefined();
  });

  it("maps legacy Google credentials to Pi 1.0's Gemini environment variable", () => {
    process.env.GOOGLE_API_KEY = "legacy-google-key";
    delete process.env.GEMINI_API_KEY;
    expect(__buildPiEnv({ ...baseInputs, provider: "google" }).GEMINI_API_KEY).toBe("legacy-google-key");
  });

  it("preserves an explicitly configured Gemini key", () => {
    process.env.GOOGLE_API_KEY = "legacy-google-key";
    process.env.GEMINI_API_KEY = "native-gemini-key";
    expect(__buildPiEnv({ ...baseInputs, provider: "google" }).GEMINI_API_KEY).toBe("native-gemini-key");
  });
});

describe("runPi", () => {
  it("uses Pi's native MCP to buffer an inline finding with object arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-native-mcp-"));
    const agentDir = join(dir, "agent");
    const bufferPath = join(dir, "inline.jsonl");
    const requests: any[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(await request.json());
        const firstTurn = requests.length === 1;
        const delta = firstTurn
          ? { role: "assistant", tool_calls: [{
            index: 0,
            id: "inline-1",
            type: "function",
            function: {
              name: "mcp__elek_review__create_inline_comment",
              arguments: JSON.stringify({ path: "src/a.ts", line: 7, body: "Missing null check can crash the request." }),
            },
          }] }
          : { role: "assistant", content: "Review complete." };
        const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
        const common = { id: "completion-1", object: "chat.completion.chunk", created: 1, model: "test" };
        return new Response([
          chunk({ ...common, choices: [{ index: 0, delta, finish_reason: null }] }),
          chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: firstTurn ? "tool_calls" : "stop" }] }),
          "data: [DONE]\n\n",
        ].join(""), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const originalToken = process.env.GITHUB_TOKEN;
    const originalTemp = process.env.RUNNER_TEMP;
    process.env.GITHUB_TOKEN = "ghs_fake_native_mcp_token";
    process.env.RUNNER_TEMP = dir;
    process.env.PI_EXECUTABLE = join(process.cwd(), "node_modules", ".bin", "pi");
    try {
      mkdirSync(agentDir);
      writeFileSync(join(agentDir, "models.json"), JSON.stringify({
        providers: {
          smoke: {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            api: "openai-completions",
            apiKey: "local-test-key",
            models: [{ id: "test", reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      }));
      writeReviewMcpConfig(agentDir, {
        actionPath: process.cwd(),
        repoOwner: "owner",
        repoName: "repo",
        prNumber: 42,
        bufferPath,
      });
      const progress: ProgressEvent[] = [];
      const result = await runPi("Review this change.", {
        ...baseInputs,
        provider: "smoke",
        model: "",
        thinking: "off",
        tools: resolveMode("review").piTools,
        runTimeoutSeconds: 20,
      }, async (event) => { progress.push(event); }, true, { agentDir, promptName: "native-mcp" });

      expect(result.conclusion).toBe("success");
      expect(result.output).toBe("Review complete.");
      expect(requests).toHaveLength(2);
      expect(requests[0].model).toBe("test");
      expect(requests[0].tools.map((tool: any) => tool.function.name).sort()).toEqual(
        resolveMode("review").piTools.split(",").sort(),
      );
      const toolResult = requests[1].messages.find((message: any) => message.role === "tool");
      expect(toolResult.content).toContain('"buffered": true');
      expect(progress).toContainEqual({ type: "tool_start", detail: "mcp__elek_review__create_inline_comment" });
      expect(JSON.parse(readFileSync(bufferPath, "utf-8"))).toMatchObject({
        path: "src/a.ts", line: 7, body: "Missing null check can crash the request.",
      });
    } finally {
      server.stop(true);
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
      if (originalTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = originalTemp;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses provider-reported JSON usage when pi emits exact token and cost data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-pi-usage-"));
    const fakePi = join(dir, "pi");
    writeFileSync(fakePi, [
      "#!/usr/bin/env bash",
      "cat <<'JSON'",
      "{\"type\":\"session\",\"id\":\"session-1\"}",
      "{\"type\":\"turn_start\"}",
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
      expect(result.costUsd).toBe(0.00789);
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
});
