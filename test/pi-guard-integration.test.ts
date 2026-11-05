import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPi } from "../src/pi";
import type { ActionInputs } from "../src/types";

interface ModelRequest {
  messages: Array<{ role: string; content: string }>;
}

// A listing of the repository root through the real Pi CLI must not show
// protected entries: Pi works in a copy of the tracked files.
async function runToolTurn(toolCall: { name: string; arguments: Record<string, unknown> }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "elek-pi-guard-"));
  const workspace = join(dir, "workspace");
  const agentDir = join(dir, "agent");
  const requests: ModelRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json() as ModelRequest);
      const firstTurn = requests.length === 1;
      const delta = firstTurn
        ? { role: "assistant", tool_calls: [{
          index: 0, id: "tool-1", type: "function",
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
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
    GITHUB_WORKSPACE: workspace,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const previousCwd = process.cwd();
  Object.assign(process.env, overrides);
  try {
    mkdirSync(workspace, { recursive: true });
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", workspace, ...args], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
      expect(result.exitCode).toBe(0);
    };
    git("init", "-q");
    writeFileSync(join(workspace, "service.ts"), "export const ok = true;\n");
    writeFileSync(join(workspace, "api-token.json"), "{\"token\":\"canary\"}\n");
    git("add", "service.ts", "api-token.json");
    git("commit", "-q", "-m", "fixture");
    git("config", "http.extraheader", "AUTHORIZATION: basic canary");
    writeFileSync(join(workspace, ".env"), "TOKEN=canary\n");
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
    const inputs: ActionInputs = {
      provider: "smoke", model: "test", thinking: "off",
      prompt: "", runTimeoutSeconds: 20,
      configPath: ".elek.yml", stickyComment: true,
      severityThreshold: "",
    };
    // Pi inherits the working directory; in Actions that is GITHUB_WORKSPACE.
    process.chdir(workspace);
    const result = await runPi("Review this change.", inputs);

    expect(result.conclusion).toBe("success");
    return requests[1].messages.find((message) => message.role === "tool")?.content ?? "";
  } finally {
    process.chdir(previousCwd);
    server.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

it("shows Pi no protected entries when it lists the repository root", async () => {
  const listing = await runToolTurn({ name: "ls", arguments: { path: "." } });
  // Pi sees a copy of the tracked files: no .git, no untracked .env, and
  // no tracked file with a protected name.
  expect(listing).toContain("service.ts");
  expect(listing).not.toContain(".git");
  expect(listing).not.toContain(".env");
  expect(listing).not.toContain("api-token.json");
}, 30_000);

it("passes Pi's real grep output through the result filter intact", async () => {
  // Pi runs offline, so grep needs rg on PATH; CI installs it. Failing here
  // beats skipping: a filter that misreads Pi's grep format would turn
  // every search into "No matches found" while CI stayed green.
  expect(Bun.which("rg"), "rg must be on PATH for this test").toBeTruthy();
  const matches = await runToolTurn({ name: "grep", arguments: { pattern: "export const ok", path: "." } });
  expect(matches).toContain("service.ts:1: export const ok = true;");
  expect(matches).not.toContain("canary");
  // A failed search keeps its error instead of reading as no matches.
  const failed = await runToolTurn({ name: "grep", arguments: { pattern: "x", path: "does-not-exist" } });
  expect(failed).not.toBe("No matches found");
  expect(failed.toLowerCase()).toContain("not found");
}, 60_000);
