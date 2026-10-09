import { expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPi, type ProgressEvent } from "../src/pi";
import type { ActionInputs } from "../src/types";

interface ModelRequest {
  model: string;
  tools: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: string }>;
}

it("runs the real Pi CLI with guarded native tools and no MCP discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elek-pi-native-"));
  const agentDir = join(dir, "agent");
  const mcpStarted = join(dir, "mcp-started");
  const requests: ModelRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json() as ModelRequest);
      const firstTurn = requests.length === 1;
      const delta = firstTurn
        ? { role: "assistant", tool_calls: [{
          index: 0, id: "read-1", type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: ".git/config" }) },
        }] }
        : { role: "assistant", content: "Review complete." };
      const common = { id: "completion-1", object: "chat.completion.chunk", created: 1, model: "test" };
      const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      return new Response([
        chunk({ ...common, choices: [{ index: 0, delta, finish_reason: null }] }),
        chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: firstTurn ? "tool_calls" : "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const overrides = {
    PI_EXECUTABLE: join(process.cwd(), "node_modules/.bin/pi"),
    PI_CODING_AGENT_DIR: agentDir,
    RUNNER_TEMP: dir,
    GITHUB_WORKSPACE: process.cwd(),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        smoke: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: "openai-completions", apiKey: "local-test-key",
          models: [{ id: "test", reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    }));
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
      mcpServers: {
        unexpected: {
          command: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(mcpStarted)}, 'started')`],
          exposure: "direct",
        },
      },
    }));
    const inputs: ActionInputs = {
      triggerPhrase: "@pi", provider: "smoke", model: "", thinking: "off",
      prompt: "", systemPrompt: "", maxTurns: 4, runTimeoutSeconds: 20,
      tools: "read,grep,find,ls", configPath: ".elek.yml", branchPrefix: "elek/",
      actorFilter: "", allowedBots: "", stickyComment: true, mode: "review",
      reviewStrategy: "solo", reviewModels: "", validatorModel: "", validatorThinking: "",
      severityThreshold: "", showCost: true, costRates: "",
    };
    const progress: ProgressEvent[] = [];
    const result = await runPi("Review this change.", inputs, async (event) => { progress.push(event); });

    expect(result.conclusion).toBe("success");
    expect(result.output).toBe("Review complete.");
    expect(requests).toHaveLength(2);
    expect(requests[0].model).toBe("test");
    expect(requests[0].tools.map((tool) => tool.function.name).sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(requests[1].messages.find((message) => message.role === "tool")?.content).toContain("Access denied");
    expect(progress).toContainEqual({ type: "tool_start", detail: "read" });
    expect(existsSync(mcpStarted)).toBe(false);
  } finally {
    server.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
