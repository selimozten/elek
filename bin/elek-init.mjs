#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDERS = {
  deepseek: {
    secret: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-pro",
    thinking: "high",
    keyInput: "deepseek_api_key",
  },
  openrouter: {
    secret: "OPENROUTER_API_KEY",
    model: "moonshotai/kimi-k2.7-code",
    thinking: "high",
    keyInput: "openrouter_api_key",
  },
  anthropic: {
    secret: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-4-6",
    thinking: "xhigh",
    keyInput: "anthropic_api_key",
  },
  openai: {
    secret: "OPENAI_API_KEY",
    model: "gpt-5.5",
    thinking: "high",
    keyInput: "openai_api_key",
  },
  google: {
    secret: "GOOGLE_API_KEY",
    model: "gemini-3.1-pro-preview",
    thinking: "high",
    keyInput: "google_api_key",
  },
};

const DEFAULTS = {
  provider: "deepseek",
  strategy: "solo",
  actionRef: "selimozten/elek@v1",
  workflowPath: ".github/workflows/elek.yml",
  configPath: ".elek.yml",
  maxCostUsd: "",
  writeConfig: true,
  force: false,
};

export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "init") continue;
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--no-config") {
      options.writeConfig = false;
      continue;
    }
    if (arg === "--config") {
      options.writeConfig = true;
      continue;
    }

    const [flag, inlineValue] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const needsValue = [
      "--provider",
      "--model",
      "--secret",
      "--strategy",
      "--max-cost-usd",
      "--action-ref",
      "--workflow",
      "--config-path",
    ];
    if (needsValue.includes(flag)) {
      const value = inlineValue ?? argv[++i];
      if (!value) throw new Error(`${flag} requires a value`);
      switch (flag) {
        case "--provider":
          options.provider = value;
          break;
        case "--model":
          options.model = value;
          break;
        case "--secret":
          options.secret = value;
          break;
        case "--strategy":
          options.strategy = value;
          break;
        case "--max-cost-usd":
          options.maxCostUsd = value;
          break;
        case "--action-ref":
          options.actionRef = value;
          break;
        case "--workflow":
          options.workflowPath = value;
          break;
        case "--config-path":
          options.configPath = value;
          break;
      }
      continue;
    }

    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }

  if (positional.length > 0) throw new Error(`Unexpected argument: ${positional[0]}`);
  return finalizeOptions(options);
}

export function finalizeOptions(options) {
  const providerDefaults = PROVIDERS[options.provider];
  if (!providerDefaults) {
    throw new Error(`Unsupported provider: ${options.provider}. Choose one of: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  if (!["solo", "crosscheck", "council"].includes(options.strategy)) {
    throw new Error("Unsupported strategy. Choose one of: solo, crosscheck, council");
  }
  if (options.maxCostUsd && (!Number.isFinite(Number(options.maxCostUsd)) || Number(options.maxCostUsd) <= 0)) {
    throw new Error("--max-cost-usd must be a positive number");
  }
  return {
    ...options,
    model: options.model ?? providerDefaults.model,
    secret: options.secret ?? providerDefaults.secret,
    thinking: options.thinking ?? providerDefaults.thinking,
    keyInput: providerDefaults.keyInput,
  };
}

export function renderWorkflow(options) {
  const configLine = options.writeConfig ? `          config_path: ${options.configPath}\n` : "";
  return `name: elek

on:
  pull_request: { types: [opened, synchronize, reopened] }
  issues: { types: [opened] }
  issue_comment: { types: [created] }

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: elek-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.event.issue.number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    if: \${{ github.event_name != 'issue_comment' || !endsWith(github.actor, '[bot]') }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6.0.3
        with:
          fetch-depth: 0
      - name: Run elek review
        uses: ${options.actionRef}
        with:
          ${options.keyInput}: \${{ secrets.${options.secret} }}
          provider: ${options.provider}
          model: ${options.model}
          thinking: ${options.thinking}
${configLine}`;
}

export function renderConfig(options) {
  const lines = [
    "severity_threshold: important",
    "",
    "ignore_paths:",
    "  - docs/**",
    "  - \"*.md\"",
    "",
    "instructions:",
    "  - Treat auth, permissions, data deletion, migrations, and billing changes as high-risk.",
    "  - Require tests for parser, config, and security-sensitive behavior changes.",
  ];

  if (options.strategy !== "solo") {
    lines.unshift(
      `review_strategy: ${options.strategy}`,
      "",
    );
  }
  if (options.maxCostUsd) {
    lines.splice(options.strategy !== "solo" ? 2 : 0, 0, `max_cost_usd: ${options.maxCostUsd}`, "");
  }
  return `${lines.join("\n")}\n`;
}

export function planFiles(options) {
  const files = [{ path: options.workflowPath, body: renderWorkflow(options) }];
  if (options.writeConfig) files.push({ path: options.configPath, body: renderConfig(options) });
  return files;
}

export function writePlannedFiles(options, cwd = process.cwd()) {
  const written = [];
  for (const file of planFiles(options)) {
    const target = join(cwd, file.path);
    if (existsSync(target) && !options.force) {
      throw new Error(`${file.path} already exists. Re-run with --force to overwrite.`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.body, "utf8");
    written.push(file.path);
  }
  return written;
}

export function helpText() {
  return `elek-init

Create a starter elek GitHub Actions workflow.

Usage:
  npx --package github:selimozten/elek elek-init [options]

Options:
  --provider <name>       deepseek, openrouter, anthropic, openai, google
  --model <id>            provider model id
  --secret <name>         GitHub Actions secret name for the provider key
  --strategy <name>       solo, crosscheck, or council
  --max-cost-usd <n>      add a soft cost cap to .elek.yml
  --config                write .elek.yml, enabled by default
  --no-config             write only .github/workflows/elek.yml
  --force                 overwrite existing files
  --action-ref <ref>      action ref to use, default selimozten/elek@v1
  --workflow <path>       workflow path, default .github/workflows/elek.yml
  --config-path <path>    config path, default .elek.yml
`;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  const written = writePlannedFiles(options, cwd);
  process.stdout.write(`Created ${written.join(" and ")}.\n`);
  process.stdout.write(`Add repository secret ${options.secret}, then open a PR to test elek.\n`);
  return 0;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`elek-init: ${error.message}\n`);
    process.exitCode = 1;
  }
}
