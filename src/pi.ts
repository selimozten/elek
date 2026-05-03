/**
 * pi CLI runner — spawns pi in JSON mode for streaming progress updates.
 * Calls back on progress events so the orchestrator can update the tracking comment
 * step-by-step, matching Claude Code's progressive checklist UX.
 */
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import type { ActionInputs, PiRunResult } from "../types";

export interface ProgressEvent {
  type: "thinking" | "tool_start" | "tool_end" | "text" | "done";
  detail?: string;
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
): Promise<PiRunResult> {
  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const promptDir = join(tmpDir, "pi-prompts");
  if (!existsSync(promptDir)) {
    mkdirSync(promptDir, { recursive: true });
  }

  const promptFile = join(promptDir, "prompt.md");
  writeFileSync(promptFile, prompt, "utf-8");

  const piBin = findPiBinary();
  const args = buildPiArgs(inputs, promptFile);
  const env = buildPiEnv(inputs);

  console.log(`pi binary: ${piBin}`);
  console.log(`Provider: ${inputs.provider}, Model: ${inputs.model || "default"}, Thinking: ${inputs.thinking}`);

  const startTime = Date.now();
  const outputParts: string[] = [];
  let currentTool = "";
  let toolCount = 0;

  return new Promise((resolve) => {
    // Use --mode json for streaming events (JSONL format)
    const jsonArgs = [...args, "--mode", "json"];
    
    // Remove -p since --mode json already implies non-interactive
    const filteredArgs = jsonArgs.filter((a) => a !== "-p");

    console.log(`Command: ${piBin} ${filteredArgs.map((a) => (a.startsWith("@") ? "@<prompt>" : a)).join(" ")}`);

    const child = spawn(piBin, filteredArgs, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30 * 60 * 1000,
    });

    const rl = createInterface({ input: child.stdout! });
    let stderr = "";

    child.stderr!.on("data", (data) => {
      stderr += data.toString();
    });

    rl.on("line", (line: string) => {
      try {
        const event = JSON.parse(line);

        // Track tool usage for progress
        if (event.type === "tool_execution_start") {
          currentTool = event.toolName || "unknown";
          toolCount++;
          onProgress?.({
            type: "tool_start",
            detail: `Running ${currentTool}...`,
          });
        } else if (event.type === "tool_execution_end") {
          onProgress?.({
            type: "tool_end",
            detail: `Completed ${currentTool}`,
          });
        } else if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update?.type === "text_delta") {
            outputParts.push(update.delta);
            onProgress?.({
              type: "text",
              detail: "Writing review...",
            });
          } else if (update?.type === "thinking_delta") {
            onProgress?.({
              type: "thinking",
              detail: "Analyzing...",
            });
          }
        }
      } catch {
        // Non-JSON line (stderr bleed-through), ignore
      }
    });

    child.on("close", (code) => {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`pi exited with code ${code} in ${elapsed.toFixed(1)}s`);

      const output = outputParts.join("").trim() || stderr.trim();

      if (code === 0 && output) {
        resolve({
          conclusion: "success",
          output,
          turnsUsed: toolCount,
          costUsd: 0,
        });
      } else {
        console.error(`pi failed (code ${code}):`, output.substring(0, 500));
        resolve({
          conclusion: "failure",
          output: output || `Exit code ${code}`,
          turnsUsed: toolCount,
          costUsd: 0,
        });
      }
    });

    child.on("error", (err) => {
      console.error(`pi spawn error:`, err.message);
      resolve({
        conclusion: "failure",
        output: err.message,
        turnsUsed: 0,
        costUsd: 0,
      });
    });
  });
}

/**
 * Build the CLI arguments for pi.
 */
function buildPiArgs(inputs: ActionInputs, promptFile: string): string[] {
  const args: string[] = [
    "--no-session",
    "--provider", inputs.provider,
    "--thinking", inputs.thinking,
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
  ];

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
function buildPiEnv(_inputs: ActionInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || "/root",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };

  // Pass through all API key env vars that pi's AuthStorage checks
  const keyVars = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
    "XAI_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY",
    "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ];

  for (const v of keyVars) {
    if (process.env[v]) env[v] = process.env[v];
  }

  return env;
}
