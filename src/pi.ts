/**
 * pi CLI runner — shells out to `pi` in print mode.
 * This is the model-agnostic interface. Any provider pi supports works.
 *
 * Finds pi binary from:
 *   1. PI_EXECUTABLE env var (explicit override)
 *   2. Global npm install (~/.local/bin/pi, /usr/local/bin/pi, etc.)
 *   3. npx pi (fallback)
 */
import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { ActionInputs, PiRunResult } from "../types";

/**
 * Find the pi binary path. Checks common locations.
 */
function findPiBinary(): string {
  // Explicit override
  if (process.env.PI_EXECUTABLE && existsSync(process.env.PI_EXECUTABLE)) {
    return process.env.PI_EXECUTABLE;
  }

  // Check common locations in priority order
  const candidates = [
    // node_modules/.bin from the action itself (GITHUB_ACTION_PATH)
    `${process.env.GITHUB_ACTION_PATH || ""}/node_modules/.bin/pi`,
    // Global npm install on Linux
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

  // Fall back to PATH lookup
  console.log("pi not found at known paths, using PATH lookup");
  return "pi";
}

/**
 * Run pi with the given prompt and return the result.
 *
 * Uses pi's print mode (-p) for non-interactive execution.
 * pi handles all provider/model/auth resolution from environment variables.
 */
export function runPi(prompt: string, inputs: ActionInputs): PiRunResult {
  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const promptDir = join(tmpDir, "pi-prompts");
  if (!existsSync(promptDir)) {
    mkdirSync(promptDir, { recursive: true });
  }

  // Write prompt to file to avoid shell escaping issues
  const promptFile = join(promptDir, "prompt.md");
  writeFileSync(promptFile, prompt, "utf-8");

  const piBin = findPiBinary();
  const args = buildPiArgs(inputs, promptFile);
  const env = buildPiEnv(inputs);

  console.log(`pi binary: ${piBin}`);
  console.log(`Provider: ${inputs.provider}, Model: ${inputs.model || "default"}, Thinking: ${inputs.thinking}`);
  console.log(`Command: ${piBin} ${args.join(" ")}`);

  const startTime = Date.now();

  try {
    const output = execFileSync(piBin, args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
      timeout: 30 * 60 * 1000, // 30 minute timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`pi completed in ${elapsed.toFixed(1)}s`);

    return {
      conclusion: "success",
      output: output.trim(),
      turnsUsed: 0, // pi print mode doesn't expose turn count
      costUsd: 0,
    };
  } catch (err: any) {
    const elapsed = (Date.now() - startTime) / 1000;

    // pi might produce useful output even on non-zero exit
    const output =
      err.stdout?.trim() || err.stderr?.trim() || err.message || "Unknown error";

    console.error(`pi exited with error (after ${elapsed.toFixed(1)}s):`);
    console.error(output.substring(0, 1000));

    return {
      conclusion: "failure",
      output,
      turnsUsed: 0,
      costUsd: 0,
    };
  }
}

/**
 * Build the CLI arguments for pi.
 */
function buildPiArgs(inputs: ActionInputs, promptFile: string): string[] {
  const args: string[] = [
    "-p", // print mode (non-interactive)
    "--no-session", // don't persist sessions
    "--provider",
    inputs.provider,
    "--thinking",
    inputs.thinking,
    "--no-extensions", // don't load user extensions
    "--no-skills", // don't load user skills
    "--no-context-files", // don't load AGENTS.md
  ];

  if (inputs.model) {
    args.push("--model", inputs.model);
  }

  if (inputs.systemPrompt) {
    args.push("--system-prompt", inputs.systemPrompt);
  }

  // Tools
  if (inputs.tools) {
    args.push("--tools", inputs.tools);
  }

  // The prompt file (pi reads @file arguments)
  args.push(`@${promptFile}`);

  return args;
}

/**
 * Build the environment variables for pi.
 * Maps action inputs to the standard API key env vars pi recognizes.
 */
function buildPiEnv(inputs: ActionInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || "/root",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };

  // pi auto-discovers keys from standard env vars based on provider.
  // These are the env vars pi's AuthStorage checks (in priority order).
  // We pass through whatever was provided by the workflow.
  // pi will pick the one matching the --provider flag.

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  // Google
  if (process.env.GOOGLE_API_KEY) {
    env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  }
  // DeepSeek
  if (process.env.DEEPSEEK_API_KEY) {
    env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  }
  // Groq
  if (process.env.GROQ_API_KEY) {
    env.GROQ_API_KEY = process.env.GROQ_API_KEY;
  }
  // Mistral
  if (process.env.MISTRAL_API_KEY) {
    env.MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
  }
  // xAI
  if (process.env.XAI_API_KEY) {
    env.XAI_API_KEY = process.env.XAI_API_KEY;
  }
  // OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  }
  // Z.AI
  if (process.env.ZAI_API_KEY) {
    env.ZAI_API_KEY = process.env.ZAI_API_KEY;
    console.log(`ZAI_API_KEY present, length: ${process.env.ZAI_API_KEY.length}`);
  }

  // AWS Bedrock (pi checks these directly)
  if (process.env.AWS_REGION) env.AWS_REGION = process.env.AWS_REGION;
  if (process.env.AWS_ACCESS_KEY_ID) env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
  if (process.env.AWS_SECRET_ACCESS_KEY) env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
  if (process.env.AWS_SESSION_TOKEN) env.AWS_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN;

  // Google Vertex
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  if (process.env.ANTHROPIC_VERTEX_PROJECT_ID) {
    env.ANTHROPIC_VERTEX_PROJECT_ID = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  }

  return env;
}
