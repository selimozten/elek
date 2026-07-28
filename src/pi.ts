/**
 * pi CLI runner — spawns pi in JSON mode for streaming progress updates.
 * Calls back on progress events so the orchestrator can update the tracking comment
 * step-by-step, matching the progressive checklist UX users expect.
 *
 * Event format (verified against pi 0.72.1, see /opt/homebrew/.../docs/json.md):
 *   - {"type":"session", id, version, ...}                 first line, session header
 *   - {"type":"agent_start"} | {"type":"agent_end", messages:[...]}
 *   - {"type":"turn_start"} | {"type":"turn_end", message, toolResults}
 *   - {"type":"message_start", message} | {"type":"message_end", message}
 *   - {"type":"message_update", message, assistantMessageEvent:{type, ...}}
 *       assistantMessageEvent.type ∈ text_start|text_delta|text_end|
 *                                    thinking_start|thinking_delta|thinking_end|
 *                                    toolcall_start|toolcall_delta|toolcall_end|done|error
 *   - {"type":"tool_execution_start", toolCallId, toolName, args}
 *   - {"type":"tool_execution_update", ...partialResult}
 *   - {"type":"tool_execution_end", toolCallId, toolName, result, isError}
 *
 * Final assistant text comes from agent_end.messages — the last assistant message's
 * `content` array filtered for {type:"text"} entries. Streaming text_delta events
 * are used only for progress signaling; they would over-aggregate across turns.
 */
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import type { ActionInputs, PiRunResult } from "./types";
import { estimateRunCost, modelLabelFor, resolveRates, type ReviewCost } from "./review/cost";

export interface ProgressEvent {
  type: "thinking" | "tool_start" | "tool_end" | "text" | "done";
  detail?: string;
}

interface PiTextContent { type: "text"; text: string }
interface PiThinkingContent { type: "thinking"; thinking: string }
interface PiToolCall { type: "toolCall"; toolName?: string }
type PiContent = PiTextContent | PiThinkingContent | PiToolCall | { type: string; [k: string]: unknown };

interface PiAssistantMessage {
  role: "assistant";
  content: PiContent[];
  stopReason?: string;
  errorMessage?: string;
  usage?: PiUsage;
}

interface PiUsage {
  input?: number;
  output?: number;
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cost?: {
    total?: number;
    input?: number;
    output?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Find the pi binary path. Checks common locations.
 */
function findPiBinary(): string {
  if (process.env.PI_EXECUTABLE && existsSync(process.env.PI_EXECUTABLE)) {
    return process.env.PI_EXECUTABLE;
  }

  const candidates = [
    `${process.env.GITHUB_ACTION_PATH || ""}/node_modules/.bin/pi`,
    `${process.env.HOME || "/root"}/.local/bin/pi`,
    "/usr/local/bin/pi",
    "/usr/bin/pi",
  ];

  for (const path of candidates) {
    if (path && existsSync(path)) {
      console.log(`Found pi at: ${path}`);
      return path;
    }
  }

  console.log("pi not found at known paths, using PATH lookup");
  return "pi";
}

function killPiProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Process already exited.
  }
}

/**
 * Run pi with streaming JSON mode output.
 * Calls onProgress for each event so the caller can update the tracking comment.
 */
export async function runPi(
  prompt: string,
  inputs: ActionInputs,
  onProgress?: (event: ProgressEvent) => Promise<void>,
  /** When true, pi loads extensions (needed for pi-mcp-adapter). */
  loadExtensions?: boolean,
  options: { promptName?: string } = {},
): Promise<PiRunResult> {
  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const promptDir = join(tmpDir, "pi-prompts");
  if (!existsSync(promptDir)) {
    mkdirSync(promptDir, { recursive: true });
  }

  const promptStem = (options.promptName || "prompt")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "prompt";
  const promptFile = join(promptDir, `${promptStem}.md`);
  writeFileSync(promptFile, prompt, "utf-8");

  const piBin = findPiBinary();
  const args = buildPiArgs(inputs, promptFile, !!loadExtensions);
  const env = buildPiEnv(inputs);

  console.log(`pi binary: ${piBin}`);
  const cliThinking = piThinkingLevel(inputs.thinking);
  console.log(
    `Provider: ${inputs.provider}, Model: ${inputs.model || "default"}, Thinking: ${
      cliThinking === inputs.thinking ? inputs.thinking : `${inputs.thinking} (pi ${cliThinking})`
    }`,
  );
  const runModelLabel = modelLabelFor(inputs);

  const startTime = Date.now();
  let sessionId: string | undefined;
  let toolCount = 0;
  let turnCount = 0;
  let finalAssistant: PiAssistantMessage | undefined;
  let lastErrorMessage: string | undefined;
  let terminationMessage: string | undefined;
  let settled = false;
  // Streaming text deltas — used as a fallback if agent_end is missing.
  // Reset at every turn_start so we keep only the last turn's text.
  let streamingText = "";

  // pi --mode json hangs forever when spawned with stdio:["pipe",…] from
  // Node — pi keeps the stdin pipe open waiting for input that never
  // arrives. Reproduced locally (see /tmp/elek-debug/repro.mjs in dev
  // history): hang with stdio:["pipe",…], works perfectly with
  // stdio:["ignore",…] (stdin closed). The fix is in the spawn call below.
  // Set ELEK_PI_TEXT_MODE=1 to fall back to `pi -p` if JSON mode regresses.
  const useJsonMode = process.env.ELEK_PI_TEXT_MODE !== "1";

  return new Promise((resolve) => {
    const finalArgs = useJsonMode
      ? [...args.filter((a) => a !== "-p"), "--mode", "json"]
      : ["-p", ...args];

    console.log(
      `Command: ${piBin} ${finalArgs.map((a) => (a.startsWith("@") ? "@<prompt>" : a)).join(" ")}`,
    );

    const child = spawn(piBin, finalArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe"], // close stdin (pi -p doesn't read it)
      detached: process.platform !== "win32",
    });
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const terminatePi = (message: string) => {
      if (terminationMessage || settled) return;
      terminationMessage = message;
      console.error(message);
      killPiProcess(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled && child.exitCode === null) {
          killPiProcess(child.pid, "SIGKILL");
        }
      }, 1000);
    };
    const timeoutMs = inputs.runTimeoutSeconds * 1000;
    const timeoutTimer = setTimeout(
      () => terminatePi(`pi timed out after ${inputs.runTimeoutSeconds}s`),
      timeoutMs,
    );

    let stderr = "";
    let stdoutRaw = "";

    child.stderr!.on("data", (data) => {
      stderr += data.toString();
    });

    if (!useJsonMode) {
      // Text mode: just collect stdout as the assistant's review text.
      child.stdout!.on("data", (chunk) => {
        stdoutRaw += chunk.toString();
      });
    }

    const rl = useJsonMode
      ? createInterface({ input: child.stdout! })
      : null;

    rl?.on("line", (line: string) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return; // non-JSON line (warnings, etc.)
      }

      switch (event.type) {
        case "session":
          sessionId = event.id;
          break;

        case "turn_start":
          turnCount++;
          streamingText = "";
          if (turnCount > inputs.maxTurns) {
            terminatePi(`pi exceeded max turns (${inputs.maxTurns})`);
          }
          break;

        case "tool_execution_start": {
          const toolName: string = event.toolName || "unknown";
          toolCount++;
          // Render bash commands as `bash(<cmd>)` for nicer progress lines.
          const detail =
            toolName === "bash" && event.args?.command
              ? `bash(${String(event.args.command).split("\n")[0].slice(0, 60)})`
              : toolName;
          onProgress?.({ type: "tool_start", detail });
          break;
        }

        case "tool_execution_end":
          onProgress?.({
            type: "tool_end",
            detail: event.toolName || "tool",
          });
          break;

        case "message_update": {
          const update = event.assistantMessageEvent;
          if (!update) break;
          if (update.type === "text_delta") {
            streamingText += update.delta || "";
            onProgress?.({ type: "text" });
          } else if (update.type === "thinking_delta") {
            onProgress?.({ type: "thinking" });
          }
          break;
        }

        case "message_end": {
          const msg = event.message;
          if (msg?.role === "assistant") {
            finalAssistant = msg;
            if (msg.errorMessage) lastErrorMessage = msg.errorMessage;
          }
          break;
        }

        case "agent_end": {
          // Authoritative final state — pick the last assistant message.
          const messages: PiAssistantMessage[] = (event.messages || []).filter(
            (m: any) => m?.role === "assistant",
          );
          if (messages.length > 0) {
            finalAssistant = messages[messages.length - 1];
            if (finalAssistant?.errorMessage) lastErrorMessage = finalAssistant.errorMessage;
          }
          break;
        }
      }
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(
        `pi exited code=${code} in ${elapsed.toFixed(1)}s · turns=${turnCount} · tools=${toolCount}`,
      );

      // AWAIT the final progress update — otherwise it races with run.ts's
      // post-pi `updateTrackingComment(reviewBody)` and the progress checklist
      // can land *after* the review, overwriting it.
      try {
        await onProgress?.({ type: "done" });
      } catch {
        // already logged inside onProgress
      }

      const output = useJsonMode
        ? (extractAssistantText(finalAssistant) || streamingText.trim())
        : stdoutRaw.trim();
      const usage = exactRunCostFromPi(finalAssistant, runModelLabel, inputs.costRates) ?? estimateRunCost({
        modelLabel: runModelLabel,
        prompt,
        output,
        costRates: inputs.costRates,
      });
      const stopReason = finalAssistant?.stopReason;
      const isErrorStop = stopReason === "error" || stopReason === "aborted";

      if (!terminationMessage && code === 0 && output && !isErrorStop) {
        resolve({
          conclusion: "success",
          output,
          sessionId,
          turnsUsed: turnCount,
          durationSeconds: elapsed,
          costUsd: usage.costUsd,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimated: usage.estimated,
            modelLabel: usage.modelLabel,
            source: usage.source,
          },
        });
      } else {
        const errMsg =
          terminationMessage ||
          lastErrorMessage ||
          output ||
          stderr.trim().slice(-500) ||
          `pi exited with code ${code}`;
        console.error(`pi failed: ${errMsg.substring(0, 500)}`);
        resolve({
          conclusion: "failure",
          output: errMsg,
          sessionId,
          turnsUsed: turnCount,
          durationSeconds: elapsed,
          costUsd: usage.costUsd,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimated: usage.estimated,
            modelLabel: usage.modelLabel,
            source: usage.source,
          },
        });
      }
    });

    child.on("error", async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const elapsed = (Date.now() - startTime) / 1000;
      console.error(`pi spawn error:`, err.message);
      try {
        await onProgress?.({ type: "done" });
      } catch {
        // already logged inside onProgress
      }
      resolve({
        conclusion: "failure",
        output: err.message,
        turnsUsed: 0,
        durationSeconds: elapsed,
        costUsd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          estimated: false,
          modelLabel: runModelLabel,
          source: "unknown",
        },
      });
    });
  });
}

/** Concatenate the text content blocks of an assistant message. */
function extractAssistantText(msg?: PiAssistantMessage): string {
  if (!msg) return "";
  return msg.content
    .filter((c): c is PiTextContent => c.type === "text" && typeof (c as PiTextContent).text === "string")
    .map((c) => c.text)
    .join("")
    .trim();
}

function exactRunCostFromPi(
  msg: PiAssistantMessage | undefined,
  modelLabel: string,
  costRates: string,
): ReviewCost | undefined {
  const usage = msg?.usage;
  if (!usage) return undefined;
  const inputTokens = firstNonNegativeInteger(
    usage.input,
    usage.inputTokens,
    usage.promptTokens,
  );
  const outputTokens = firstNonNegativeInteger(
    usage.output,
    usage.outputTokens,
    usage.completionTokens,
  );
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const safeInput = inputTokens ?? 0;
  const safeOutput = outputTokens ?? 0;
  if (safeInput === 0 && safeOutput === 0) return undefined;

  const providerCost = nonNegativeNumber(usage.cost?.total);
  if (providerCost !== undefined) {
    return {
      inputTokens: safeInput,
      outputTokens: safeOutput,
      costUsd: providerCost,
      estimated: false,
      modelLabel,
      source: "provider",
    };
  }

  const rates = resolveRates(modelLabel, costRates);
  const costUsd =
    (safeInput / 1_000_000) * rates.inputPerMillion +
    (safeOutput / 1_000_000) * rates.outputPerMillion;
  return {
    inputTokens: safeInput,
    outputTokens: safeOutput,
    costUsd,
    estimated: true,
    modelLabel,
    source: rates.source,
  };
}

function firstNonNegativeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    return Math.floor(value);
  }
  return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Build the CLI arguments for pi.
 */
export function buildPiArgs(
  inputs: ActionInputs,
  promptFile: string,
  loadExtensions: boolean,
): string[] {
  const args: string[] = [
    "--no-session",
    "--thinking", piThinkingLevel(inputs.thinking),
    "--no-skills",
    "--no-context-files",
  ];
  // `pi --model provider/model` is legal, but pairing that with a separate
  // `--provider` can make multi-provider review strategies ambiguous. When
  // the model is provider-qualified, let the model spec route itself.
  if (!inputs.model?.includes("/")) {
    args.push("--provider", inputs.provider);
  }
  // Do not rely on user/global extension discovery or a runtime `pi install`
  // (which would hit the npm registry during a review). Load exactly the
  // already-installed, lockfile-pinned local adapter package when MCP is needed.
  args.push("--no-extensions");
  if (inputs.mode !== "agent") {
    // Review subprocesses must never inherit pi's built-in mutation tools.
    // An empty tools list is used by the timeout fallback to force a
    // single-turn, supplied-context-only review.
    args.push("--no-builtin-tools");
    if (usesReadonlyReviewTools(inputs)) {
      args.push("-e", localPiReadonlyToolsPath());
    }
  }
  if (loadExtensions) {
    args.push("-e", localPiMcpAdapterPath());
  }

  // Empty model string intentionally means "use this provider's default".
  if (inputs.model) {
    args.push("--model", inputs.model);
  }

  if (inputs.systemPrompt) {
    args.push("--system-prompt", inputs.systemPrompt);
  }

  if (inputs.tools) {
    args.push("--tools", inputs.tools);
  }

  args.push(`@${promptFile}`);

  return args;
}

function localPiMcpAdapterPath(): string {
  const packageRoot = process.env.GITHUB_ACTION_PATH || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(packageRoot, "node_modules", "pi-mcp-adapter");
}

function localPiReadonlyToolsPath(): string {
  const packageRoot = process.env.GITHUB_ACTION_PATH || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(packageRoot, "src", "pi-readonly-tools.ts");
}

function toolSet(inputs: ActionInputs): Set<string> {
  return new Set(
    (inputs.tools || "")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
  );
}

function usesReadonlyReviewTools(inputs: ActionInputs): boolean {
  if (inputs.mode === "agent") return false;
  const tools = toolSet(inputs);
  const hasReadonlyTool = ["read", "grep", "find", "ls"].some((tool) => tools.has(tool));
  const hasMutationTool = ["write", "edit", "bash"].some((tool) => tools.has(tool));
  return hasReadonlyTool && !hasMutationTool;
}

function piThinkingLevel(value: string): string {
  return value.trim().toLowerCase() === "max" ? "xhigh" : value;
}

/**
 * Build the environment variables for pi.
 *
 * Both review and agent modes use a strict allowlist instead of leaking
 * `{ ...process.env }`. Agent mode runs a child that may execute shell (git
 * commit/push), so blindly passing the parent env would expose every secret
 * the workflow ever set to a process that can run arbitrary commands. Agent
 * mode only gets a few extra GitHub/workflow vars beyond the review baseline
 * — enough for git auth + pushing — never the whole environment.
 */
function buildPiEnv(inputs: ActionInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  // Baseline allowed in every mode: locale, temp dirs, and pi's own paths.
  const baseAllowedVars = [
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "RUNNER_TEMP",
    "GITHUB_ACTION_PATH", "GITHUB_WORKSPACE", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR",
  ];

  // Agent mode runs shell and pushes commits, so it additionally needs the
  // standard GitHub Actions context vars and the token git auth relies on.
  // This is deliberately narrow — NOT the full parent environment.
  const agentExtraVars = [
    "GITHUB_TOKEN", "GH_TOKEN",
    "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_OWNER",
    "GITHUB_SERVER_URL", "GITHUB_API_URL", "GITHUB_GRAPHQL_URL",
    "GITHUB_RUN_ID", "GITHUB_RUN_NUMBER", "GITHUB_SHA", "GITHUB_REF",
    "GITHUB_REF_NAME", "GITHUB_HEAD_REF", "GITHUB_BASE_REF",
    "GITHUB_WORKSPACE", "GITHUB_EVENT_NAME", "GITHUB_ACTOR",
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  ];

  const allowedVars = inputs.mode === "agent"
    ? [...baseAllowedVars, ...agentExtraVars]
    : baseAllowedVars;

  for (const v of allowedVars) {
    if (process.env[v] !== undefined) env[v] = process.env[v];
  }

  if (inputs.mode !== "agent" && toolSet(inputs).has("mcp") && process.env.GITHUB_TOKEN !== undefined) {
    env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  Object.assign(env, {
    HOME: process.env.HOME || "/root",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  });

  // Pass through all API key env vars that pi's AuthStorage checks
  const keyVars = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
    "TOGETHER_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
    "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ];

  for (const v of keyVars) {
    if (process.env[v]) env[v] = process.env[v];
  }

  return env;
}

/**
 * Test seam: the env builder is internal, but tests need to assert the
 * agent-mode allowlist doesn't leak arbitrary parent secrets.
 */
export const __buildPiEnv = buildPiEnv;
