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
import { join } from "path";
import { createInterface } from "readline";
import type { ActionInputs, PiRunResult } from "./types";
import { estimateRunCost, modelLabelFor } from "./review/cost";

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
  console.log(`Provider: ${inputs.provider}, Model: ${inputs.model || "default"}, Thinking: ${inputs.thinking}`);
  const runModelLabel = modelLabelFor(inputs);

  const startTime = Date.now();
  let sessionId: string | undefined;
  let toolCount = 0;
  let turnCount = 0;
  let finalAssistant: PiAssistantMessage | undefined;
  let lastErrorMessage: string | undefined;
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
      timeout: 30 * 60 * 1000,
    });

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
      const usage = estimateRunCost({
        modelLabel: runModelLabel,
        prompt,
        output,
        costRates: inputs.costRates,
      });
      const stopReason = finalAssistant?.stopReason;
      const isErrorStop = stopReason === "error" || stopReason === "aborted";

      if (code === 0 && output && !isErrorStop) {
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

    child.on("error", (err) => {
      console.error(`pi spawn error:`, err.message);
      onProgress?.({ type: "done" });
      resolve({
        conclusion: "failure",
        output: err.message,
        turnsUsed: 0,
        durationSeconds: 0,
        costUsd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          estimated: true,
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
    "--thinking", inputs.thinking,
    "--no-skills",
    "--no-context-files",
  ];
  // `pi --model provider/model` is legal, but pairing that with a separate
  // `--provider` can make multi-provider review strategies ambiguous. When
  // the model is provider-qualified, let the model spec route itself.
  if (!inputs.model?.includes("/")) {
    args.push("--provider", inputs.provider);
  }
  if (!loadExtensions) {
    args.push("--no-extensions");
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

/**
 * Build the environment variables for pi.
 */
function buildPiEnv(inputs: ActionInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = inputs.mode === "agent"
    ? { ...process.env }
    : {
        PATH: process.env.PATH,
        HOME: process.env.HOME || "/root",
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TMPDIR: process.env.TMPDIR,
        RUNNER_TEMP: process.env.RUNNER_TEMP,
        GITHUB_ACTION_PATH: process.env.GITHUB_ACTION_PATH,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
      };

  Object.assign(env, {
    HOME: process.env.HOME || "/root",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  });

  // Pass through all API key env vars that pi's AuthStorage checks
  const keyVars = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
    "XAI_API_KEY", "OPENROUTER_API_KEY",
    "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ];

  for (const v of keyVars) {
    if (process.env[v]) env[v] = process.env[v];
  }

  return env;
}
