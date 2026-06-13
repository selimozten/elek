/**
 * Parse the GitHub Actions event context into a structured format.
 * Handles pull_request, issues, issue_comment, pull_request_review events.
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

function parseMaxCostInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    core.warning(`Ignoring invalid max_cost_usd input: ${normalized}`);
    return undefined;
  }
  return parsed;
}

export function parseInputs(): ActionInputs {
  return {
    triggerPhrase: core.getInput("trigger_phrase") || "@pi",
    provider: core.getInput("provider") || "anthropic",
    model: core.getInput("model") || "",
    thinking: core.getInput("thinking") || "medium",
    prompt: core.getInput("prompt") || "",
    systemPrompt: core.getInput("system_prompt") || "",
    maxTurns: parseInt(core.getInput("max_turns") || "20", 10),
    tools: core.getInput("tools") || "",
    configPath: core.getInput("config_path") || ".elek.yml",
    baseBranch: core.getInput("base_branch") || undefined,
    branchPrefix: core.getInput("branch_prefix") || "elek/",
    actorFilter: core.getInput("actor_filter") || "",
    allowedBots: core.getInput("allowed_bots") || "",
    stickyComment: parseBooleanInput(core.getInput("sticky_comment"), true),
    mode: core.getInput("mode") || "review",
    reviewStrategy: core.getInput("review_strategy") || "",
    reviewModels: core.getInput("review_models") || "",
    validatorModel: core.getInput("validator_model") || "",
    severityThreshold: parseSeverityInput(core.getInput("severity_threshold")),
    showCost: parseBooleanInput(core.getInput("show_cost"), true),
    costRates: core.getInput("cost_rates") || "",
    maxCostUsd: parseMaxCostInput(core.getInput("max_cost_usd")),
  };
}

/**
 * Parse the GitHub event payload into a structured entity context.
 * Returns null for unsupported event types.
 */
export function parseEntityContext(): GitHubEntityContext | null {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventName) throw new Error("GITHUB_EVENT_NAME not set");

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH not set");

  const payload = JSON.parse(readFileSync(eventPath, "utf-8"));

  const actor = process.env.GITHUB_ACTOR || payload.sender?.login || "unknown";

  const repo = {
    owner: process.env.GITHUB_REPOSITORY_OWNER || payload.repository?.owner?.login || "",
    repo: (process.env.GITHUB_REPOSITORY || "").split("/")[1] || payload.repository?.name || "",
    fullName: process.env.GITHUB_REPOSITORY || payload.repository?.full_name || "",
    defaultBranch: payload.repository?.default_branch || "main",
  };

  const base: Pick<GitHubEntityContext, "actor" | "repo" | "triggerText" | "isPR" | "entityNumber"> = {
    actor,
    repo,
    triggerText: "",
    isPR: false,
    entityNumber: 0,
  };

  switch (eventName) {
    case "pull_request":
    case "pull_request_target": {
      const pr = payload.pull_request;
      if (!pr) return null;
      return {
        ...base,
        eventName: "pull_request",
        eventAction: payload.action || "opened",
        entityNumber: pr.number,
        isPR: true,
        triggerText: pr.body || "",
        pr: {
          title: pr.title || "",
          body: pr.body || "",
          headRef: pr.head?.ref || "",
          baseRef: pr.base?.ref || "",
          headSha: pr.head?.sha || "",
          baseSha: pr.base?.sha || "",
        },
      };
    }

    case "issues": {
      const issue = payload.issue;
      if (!issue || issue.pull_request) return null; // skip PRs that show up as issues
      return {
        ...base,
        eventName: "issues",
        eventAction: payload.action || "opened",
        entityNumber: issue.number,
        isPR: false,
        triggerText: issue.body || "",
        issue: {
          title: issue.title || "",
          body: issue.body || "",
          labels: (issue.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
          assignees: (issue.assignees || []).map((a: any) => a.login),
        },
      };
    }

    case "issue_comment": {
      const comment = payload.comment;
      const issue = payload.issue;
      if (!comment || !issue) return null;
      const isPR = !!issue.pull_request;
      return {
        ...base,
        eventName: "issue_comment",
        eventAction: payload.action || "created",
        entityNumber: issue.number,
        isPR,
        triggerText: comment.body || "",
        ...(isPR
          ? { pr: { title: issue.title || "", body: issue.body || "", headRef: "", baseRef: "", headSha: "", baseSha: "" } }
          : { issue: { title: issue.title || "", body: issue.body || "", labels: [], assignees: [] } }),
      };
    }

    case "pull_request_review": {
      const review = payload.review;
      const pr = payload.pull_request;
      if (!review || !pr) return null;
      return {
        ...base,
        eventName: "pull_request_review",
        eventAction: payload.action || "submitted",
        entityNumber: pr.number,
        isPR: true,
        triggerText: review.body || "",
        pr: {
          title: pr.title || "",
          body: pr.body || "",
          headRef: pr.head?.ref || "",
          baseRef: pr.base?.ref || "",
          headSha: pr.head?.sha || "",
          baseSha: pr.base?.sha || "",
        },
      };
    }

    case "pull_request_review_comment": {
      const reviewComment = payload.comment;
      const pr = payload.pull_request;
      if (!reviewComment || !pr) return null;
      return {
        ...base,
        eventName: "pull_request_review_comment",
        eventAction: payload.action || "created",
        entityNumber: pr.number,
        isPR: true,
        triggerText: reviewComment.body || "",
        pr: {
          title: pr.title || "",
          body: pr.body || "",
          headRef: pr.head?.ref || "",
          baseRef: pr.base?.ref || "",
          headSha: pr.head?.sha || "",
          baseSha: pr.base?.sha || "",
        },
      };
    }

    default:
      return null;
  }
}
