/**
 * pi CLI runner — spawns pi in JSON mode for streaming progress updates.
 * Calls back on progress events so the orchestrator can update the tracking comment
 * step-by-step, matching the progressive checklist UX users expect.
 *
 * Pi's JSON event stream:
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
import type { ActionInputs, PiRunErrorKind, PiRunResult, PiTurnMetric } from "./types";
import { estimateRunCost, modelLabelFor, resolveRates, type ReviewCost } from "./review/cost";

const REVIEW_SYSTEM_PROMPT = [
  "You are Elek, a noninteractive read-only CI pull-request reviewer.",
  "Find only concrete, consequential issues rooted in changed code.",
  "Use repository inspection tools only to resolve a specific uncertainty required to validate a candidate finding; a self-contained change may require no tool calls.",
  "Do not edit files, ask questions, narrate research, or continue exploring after every candidate is either verified or rejected.",
  "Return the requested review format immediately when the review is complete, including when there are no findings.",
].join(" ");

/** Native read-only tools; the workspace guard confines them to the repository. */
export const REVIEW_TOOLS = "read,grep,find,ls";

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
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
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
  const args = buildPiArgs(inputs, promptFile);
  const env = buildPiEnv();

  console.log(`pi binary: ${piBin}`);
  console.log(
    `Provider: ${inputs.provider}, Model: ${inputs.model || "default"}, Thinking: ${inputs.thinking}`,
  );
  console.log(`Prompt: ${prompt.length.toLocaleString("en-US")} chars`);
  const runModelLabel = modelLabelFor(inputs);

  const startTime = Date.now();
  let sessionId: string | undefined;
  let toolCount = 0;
  let turnCount = 0;
  let turnStartedAt: number | undefined;
  let firstResponseAt: number | undefined;
  const completedTurnMessages: PiAssistantMessage[] = [];
  const turnMetrics: PiTurnMetric[] = [];
  let providerRetries = 0;
  let finalAssistant: PiAssistantMessage | undefined;
  let lastErrorMessage: string | undefined;
  let terminationMessage: string | undefined;
  let settled = false;
  // Streaming text deltas — used as a fallback if agent_end is missing.
  // Reset at every turn_start so we keep only the last turn's text.
  let streamingText = "";

  return new Promise((resolve) => {
    const finalArgs = [...args, "--mode", "json"];

    console.log(
      `Command: ${piBin} ${finalArgs.map((a) => (a.startsWith("@") ? "@<prompt>" : a)).join(" ")}`,
    );

    const child = spawn(piBin, finalArgs, {
      env,
      // pi --mode json waits forever on an open stdin pipe; close it.
      stdio: ["ignore", "pipe", "pipe"],
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
    const timeoutTimer = inputs.runTimeoutSeconds === undefined
      ? undefined
      : setTimeout(
          () => terminatePi(`pi timed out after ${inputs.runTimeoutSeconds}s`),
          inputs.runTimeoutSeconds * 1000,
        );

    let stderr = "";

    child.stderr!.on("data", (data) => {
      stderr += data.toString();
    });

    const rl = createInterface({ input: child.stdout! });

    rl.on("line", (line: string) => {
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
          turnStartedAt = Date.now();
          firstResponseAt = undefined;
          streamingText = "";
          if (inputs.maxTurns !== undefined && turnCount > inputs.maxTurns) {
            terminatePi(`pi exceeded max turns (${inputs.maxTurns})`);
          }
          break;

        case "auto_retry_start":
          providerRetries++;
          console.warn(
            `pi provider retry ${event.attempt || providerRetries}/${event.maxAttempts || "?"} after ${event.delayMs || 0}ms`,
          );
          break;

        case "tool_execution_start": {
          toolCount++;
          onProgress?.({ type: "tool_start", detail: event.toolName || "unknown" });
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
          firstResponseAt ??= Date.now();
          if (update.type === "text_delta") {
            streamingText += update.delta || "";
            onProgress?.({ type: "text" });
          } else if (update.type === "thinking_delta") {
            onProgress?.({ type: "thinking" });
          }
          break;
        }

        case "turn_end": {
          const msg = event.message;
          if (msg?.role === "assistant") {
            completedTurnMessages.push(msg);
            const metric = turnMetricFromPi(
              msg,
              turnCount,
              turnStartedAt,
              firstResponseAt,
              Date.now(),
            );
            turnMetrics.push(metric);
            console.log(formatTurnMetric(metric));
          }
          turnStartedAt = undefined;
          firstResponseAt = undefined;
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
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(
        `pi exited code=${code} in ${elapsed.toFixed(1)}s · turns=${turnCount} · tools=${toolCount} · provider retries=${providerRetries}`,
      );

      // AWAIT the final progress update — otherwise it races with run.ts's
      // post-pi `updateTrackingComment(reviewBody)` and the progress checklist
      // can land *after* the review, overwriting it.
      try {
        await onProgress?.({ type: "done" });
      } catch {
        // already logged inside onProgress
      }

      const output = extractAssistantText(finalAssistant) || streamingText.trim();
      const exactUsage = exactRunUsageFromPi(
        completedTurnMessages.length > 0
          ? completedTurnMessages
          : finalAssistant
            ? [finalAssistant]
            : [],
        runModelLabel,
        inputs.costRates,
      );
      const usage = exactUsage ?? estimateRunCost({
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
          promptChars: prompt.length,
          thinking: inputs.thinking,
          toolCalls: toolCount,
          turnMetrics,
          stopReason,
          providerRetries,
          durationSeconds: elapsed,
          costUsd: usage.costUsd,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: exactUsage?.cacheReadTokens ?? 0,
            cacheWriteTokens: exactUsage?.cacheWriteTokens ?? 0,
            reasoningTokens: exactUsage?.reasoningTokens,
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
        const errorKind = classifyPiFailure({
          code,
          errorMessage: errMsg,
          output,
          stopReason,
          terminationMessage,
        });
        console.error(`pi failed: ${errMsg.substring(0, 500)}`);
        resolve({
          conclusion: "failure",
          output: errMsg,
          sessionId,
          turnsUsed: turnCount,
          promptChars: prompt.length,
          thinking: inputs.thinking,
          toolCalls: toolCount,
          turnMetrics,
          stopReason,
          errorKind,
          providerRetries,
          durationSeconds: elapsed,
          costUsd: usage.costUsd,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: exactUsage?.cacheReadTokens ?? 0,
            cacheWriteTokens: exactUsage?.cacheWriteTokens ?? 0,
            reasoningTokens: exactUsage?.reasoningTokens,
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
        promptChars: prompt.length,
        thinking: inputs.thinking,
        toolCalls: toolCount,
        turnMetrics,
        errorKind: "process",
        providerRetries,
        durationSeconds: elapsed,
        costUsd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimated: false,
          modelLabel: runModelLabel,
          source: "unknown",
        },
      });
    });
  });
}

function classifyPiFailure(args: {
  code: number | null;
  errorMessage: string;
  output: string;
  stopReason?: string;
  terminationMessage?: string;
}): PiRunErrorKind {
  if (args.terminationMessage?.startsWith("pi timed out")) return "timeout";
  if (args.terminationMessage?.startsWith("pi exceeded max turns")) return "turn-limit";
  if (args.stopReason === "length") return "length";
  if (args.code === 0 && !args.output && !args.stopReason) return "empty";
  if (/\b429\b|too many requests|rate[ -]?limit/i.test(args.errorMessage)) return "rate-limit";
  if (/h2 protocol error|error reading a body from connection|ECONNRESET|ETIMEDOUT|UND_ERR_|fetch failed|socket hang up|connection reset/i.test(args.errorMessage)) {
    return "transport";
  }
  if (args.stopReason === "error" || args.stopReason === "aborted") return "model";
  return "process";
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

interface PiUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

interface ExactRunUsage extends ReviewCost {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

function turnMetricFromPi(
  msg: PiAssistantMessage,
  turn: number,
  startedAt: number | undefined,
  firstResponseAt: number | undefined,
  finishedAt: number,
): PiTurnMetric {
  const usage = piUsageBreakdown(msg);
  return {
    turn,
    durationSeconds: elapsedSeconds(startedAt, finishedAt),
    firstResponseSeconds: firstResponseAt === undefined
      ? undefined
      : elapsedSeconds(startedAt, firstResponseAt),
    ...usage,
    stopReason: msg.stopReason,
  };
}

function formatTurnMetric(metric: PiTurnMetric): string {
  const firstResponse = metric.firstResponseSeconds === undefined
    ? ""
    : ` · first response=${metric.firstResponseSeconds.toFixed(1)}s`;
  const reasoning = metric.reasoningTokens === undefined
    ? ""
    : ` · reasoning=${metric.reasoningTokens}`;
  return (
    `pi turn ${metric.turn} completed in ${metric.durationSeconds.toFixed(1)}s${firstResponse}` +
    ` · input=${metric.inputTokens} · output=${metric.outputTokens}` +
    ` · cache read=${metric.cacheReadTokens} · cache write=${metric.cacheWriteTokens}${reasoning}`
  );
}

function elapsedSeconds(startedAt: number | undefined, finishedAt: number): number {
  return startedAt === undefined ? 0 : Math.max(0, finishedAt - startedAt) / 1000;
}

function piUsageBreakdown(msg: PiAssistantMessage): PiUsageBreakdown {
  const usage = msg.usage;
  const inputTokens = firstNonNegativeInteger(
    usage?.input,
    usage?.inputTokens,
    usage?.promptTokens,
  ) ?? 0;
  const outputTokens = firstNonNegativeInteger(
    usage?.output,
    usage?.outputTokens,
    usage?.completionTokens,
  ) ?? 0;
  const cacheReadTokens = firstNonNegativeInteger(usage?.cacheRead) ?? 0;
  const cacheWriteTokens = firstNonNegativeInteger(usage?.cacheWrite) ?? 0;
  const reasoningTokens = firstNonNegativeInteger(usage?.reasoning);
  const totalTokens = firstNonNegativeInteger(usage?.totalTokens) ??
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  };
}

function exactRunUsageFromPi(
  messages: PiAssistantMessage[],
  modelLabel: string,
  costRates: string,
): ExactRunUsage | undefined {
  const costs = messages
    .map((message) => exactRunCostFromPi(message, modelLabel, costRates))
    .filter((cost): cost is ReviewCost => cost !== undefined);
  if (costs.length === 0) return undefined;

  const usages = messages.map(piUsageBreakdown);
  const reportedReasoning = usages.some((usage) => usage.reasoningTokens !== undefined);
  const estimatedCosts = costs.filter((cost) => cost.source !== "provider");
  return {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cacheReadTokens: usages.reduce((sum, usage) => sum + usage.cacheReadTokens, 0),
    cacheWriteTokens: usages.reduce((sum, usage) => sum + usage.cacheWriteTokens, 0),
    reasoningTokens: reportedReasoning
      ? usages.reduce((sum, usage) => sum + (usage.reasoningTokens ?? 0), 0)
      : undefined,
    costUsd: costs.reduce((sum, cost) => sum + cost.costUsd, 0),
    estimated: costs.some((cost) => cost.estimated),
    modelLabel,
    source: estimatedCosts[0]?.source ?? "provider",
  };
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
  const cacheReadTokens = firstNonNegativeInteger(usage.cacheRead);
  const cacheWriteTokens = firstNonNegativeInteger(usage.cacheWrite);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) return undefined;
  const safeInput = inputTokens ?? 0;
  const safeOutput = outputTokens ?? 0;
  const safeCacheRead = cacheReadTokens ?? 0;
  const safeCacheWrite = cacheWriteTokens ?? 0;
  if (safeInput === 0 && safeOutput === 0 && safeCacheRead === 0 && safeCacheWrite === 0) {
    return undefined;
  }

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
    ((safeInput + safeCacheRead + safeCacheWrite) / 1_000_000) * rates.inputPerMillion +
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
): string[] {
  const args: string[] = [
    "--no-session",
    "--thinking", inputs.thinking,
    "--no-skills",
    "--no-context-files",
    "--no-approve",
    "--no-mcp",
  ];
  // Together and OpenRouter model ids can contain a slash without a provider
  // prefix. Omit --provider only when the value starts with the selected one.
  if (!inputs.model?.startsWith(`${inputs.provider}/`)) {
    args.push("--provider", inputs.provider);
  }
  args.push("--no-extensions", "-e", localWorkspaceGuardPath());

  // Pi 1.0 requires a model with --provider. An empty provider-qualified
  // pattern selects an available model from that provider without switching.
  args.push("--model", inputs.model || `${inputs.provider}/`);
  args.push("--append-system-prompt", REVIEW_SYSTEM_PROMPT);
  args.push("--tools", REVIEW_TOOLS);

  args.push(`@${promptFile}`);

  return args;
}

function localWorkspaceGuardPath(): string {
  const packageRoot = process.env.GITHUB_ACTION_PATH || resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(packageRoot, "src", "pi-workspace-guard.ts");
}

/**
 * Build the environment variables for pi from a strict allowlist: locale,
 * temp dirs, pi's own paths, and provider credentials. Never GITHUB_TOKEN.
 */
function buildPiEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  const allowedVars = [
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "RUNNER_TEMP",
    "GITHUB_ACTION_PATH", "GITHUB_WORKSPACE", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR",
  ];
  for (const v of allowedVars) {
    if (process.env[v] !== undefined) env[v] = process.env[v];
  }

  Object.assign(env, {
    HOME: process.env.HOME || "/root",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  });

  // Pass through all API key env vars that pi's AuthStorage checks
  const keyVars = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
    "TOGETHER_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY",
    "OPENCODE_API_KEY",
    "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ];

  for (const v of keyVars) {
    if (process.env[v]) env[v] = process.env[v];
  }
  if (!env.GEMINI_API_KEY && env.GOOGLE_API_KEY) {
    env.GEMINI_API_KEY = env.GOOGLE_API_KEY;
  }

  return env;
}

/** Test seam: assert the env allowlist doesn't leak parent secrets. */
export const __buildPiEnv = buildPiEnv;
