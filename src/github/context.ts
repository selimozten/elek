/**
 * Parse action inputs and the pull_request event payload.
 */
import * as core from "@actions/core";
import { readFileSync } from "fs";
import type { GitHubEntityContext, ActionInputs } from "../types.js";

function parseBooleanInput(value: string, defaultValue: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  return !["false", "0", "off", "no"].includes(normalized);
}

function parseSeverityInput(value: string): ActionInputs["severityThreshold"] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "critical" || normalized === "important" || normalized === "minor") {
    return normalized;
  }
  core.warning(`Ignoring invalid severity_threshold input: ${normalized}`);
  return "";
}

function parseMaxCostInput(value: string): number | null | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (["0", "off", "none", "false", "disabled"].includes(normalized.toLowerCase())) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    core.warning(`Ignoring invalid max_cost_usd input: ${normalized}`);
    return undefined;
  }
  return parsed;
}

function parseReviewAgentCountInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
    core.warning(`Ignoring invalid review_agent_count input: ${normalized}`);
    return undefined;
  }
  return parsed;
}

function parseMaxTurnsInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (["0", "off", "none", "false", "disabled"].includes(normalized.toLowerCase())) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    core.warning(`Ignoring invalid max_turns input: ${normalized}`);
    return undefined;
  }
  return parsed;
}

function parsePositiveIntegerInput(name: string, value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    core.warning(`Ignoring invalid ${name} input: ${normalized}`);
    return undefined;
  }
  return parsed;
}

function parseRunTimeoutInput(value: string): number | undefined {
  const normalized = value.trim();
  if (["0", "off", "none", "false", "disabled"].includes(normalized.toLowerCase())) return undefined;
  return parsePositiveIntegerInput("run_timeout_seconds", normalized);
}

export function parseInputs(): ActionInputs {
  return {
    provider: core.getInput("provider") || "anthropic",
    model: core.getInput("model") || "",
    thinking: core.getInput("thinking") || "medium",
    prompt: core.getInput("prompt") || "",
    maxTurns: parseMaxTurnsInput(core.getInput("max_turns")),
    runTimeoutSeconds: parseRunTimeoutInput(core.getInput("run_timeout_seconds")),
    configPath: core.getInput("config_path") || ".elek.yml",
    stickyComment: parseBooleanInput(core.getInput("sticky_comment"), true),
    reviewStrategy: core.getInput("review_strategy") || "",
    reviewModels: core.getInput("review_models") || "",
    reviewLenses: core.getInput("review_lenses") || "",
    reviewAgentCount: parseReviewAgentCountInput(core.getInput("review_agent_count")),
    advisorModel: core.getInput("advisor_model") || "",
    advisorThinking: core.getInput("advisor_thinking") || "",
    validatorModel: core.getInput("validator_model") || "",
    validatorThinking: core.getInput("validator_thinking") || "",
    severityThreshold: parseSeverityInput(core.getInput("severity_threshold")),
    showCost: parseBooleanInput(core.getInput("show_cost"), true),
    costRates: core.getInput("cost_rates") || "",
    maxCostUsd: parseMaxCostInput(core.getInput("max_cost_usd")),
  };
}

/**
 * A null head repo means the fork was deleted; treat it as a fork because
 * GitHub still runs the workflow without repository secrets.
 */
function isForkPullRequest(pr: any): boolean {
  const head = pr.head?.repo?.full_name;
  const base = pr.base?.repo?.full_name;
  if (!base) return false;
  return head !== base;
}

/**
 * Parse a pull_request (or pull_request_target) payload. Returns null for
 * every other event: elek only reviews pull requests.
 */
export function parseEntityContext(): GitHubEntityContext | null {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventName) throw new Error("GITHUB_EVENT_NAME not set");
  if (eventName !== "pull_request" && eventName !== "pull_request_target") return null;

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH not set");

  const payload = JSON.parse(readFileSync(eventPath, "utf-8"));
  const pr = payload.pull_request;
  if (!pr) return null;

  return {
    eventAction: payload.action || "opened",
    actor: process.env.GITHUB_ACTOR || payload.sender?.login || "unknown",
    actorAssociation: pr.author_association,
    repo: {
      owner: process.env.GITHUB_REPOSITORY_OWNER || payload.repository?.owner?.login || "",
      repo: (process.env.GITHUB_REPOSITORY || "").split("/")[1] || payload.repository?.name || "",
      fullName: process.env.GITHUB_REPOSITORY || payload.repository?.full_name || "",
      defaultBranch: payload.repository?.default_branch || "main",
    },
    entityNumber: pr.number,
    pr: {
      title: pr.title || "",
      body: pr.body || "",
      headRef: pr.head?.ref || "",
      baseRef: pr.base?.ref || "",
      headSha: pr.head?.sha || "",
      baseSha: pr.base?.sha || "",
      draft: pr.draft === true,
      isFork: isForkPullRequest(pr),
    },
  };
}
