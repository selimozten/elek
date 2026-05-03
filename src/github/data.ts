/**
 * GitHub data fetching — PR diffs, issue details, comments, etc.
 */
import type { GitHubEntityContext } from "../types";
import { getGitDiff } from "./git";
import { execSync } from "child_process";

export interface GitHubData {
  type: "pr" | "issue";
  title: string;
  body: string;
  diff?: string;
  comments: string[];
  labels: string[];
  assignees: string[];
  actor: string;
  entityNumber: number;
}

/**
 * Fetch all relevant data for a PR or issue context.
 */
export async function fetchGitHubData(
  context: GitHubEntityContext,
): Promise<GitHubData> {
  const base: GitHubData = {
    type: context.isPR ? "pr" : "issue",
    title: context.pr?.title || context.issue?.title || "",
    body: context.pr?.body || context.issue?.body || "",
    comments: [],
    labels: context.issue?.labels || [],
    assignees: context.issue?.assignees || [],
    actor: context.actor,
    entityNumber: context.entityNumber,
  };

  // Fetch PR diff
  if (context.isPR && context.pr) {
    try {
      base.diff = getGitDiff(context.pr.baseRef, context.pr.headRef);
    } catch (err) {
      console.warn("Could not fetch PR diff:", err);
    }
  }

  // Fetch recent comments (via git log or GitHub API)
  // For simplicity, we skip comment fetching here and focus on the diff + issue body

  return base;
}

/**
 * Build a comprehensive prompt from GitHub data for pi to work with.
 */
export function buildPrompt(data: GitHubData, userRequest: string): string {
  const parts: string[] = [];

  parts.push(`You are reviewing/working on a GitHub ${data.type.toUpperCase()}.`);
  parts.push("");
  parts.push(`## ${data.type === "pr" ? "Pull Request" : "Issue"} #${data.entityNumber}`);
  parts.push(`**Title:** ${data.title}`);
  parts.push(`**Author:** ${data.actor}`);
  if (data.labels.length > 0) {
    parts.push(`**Labels:** ${data.labels.join(", ")}`);
  }
  if (data.assignees.length > 0) {
    parts.push(`**Assignees:** ${data.assignees.join(", ")}`);
  }
  parts.push("");
  parts.push("### Description");
  parts.push(data.body || "(no description)");

  if (data.diff) {
    const maxDiffLines = 500;
    const diffLines = data.diff.split("\n");
    const truncated = diffLines.length > maxDiffLines
      ? diffLines.slice(0, maxDiffLines).join("\n") + `\n... (${diffLines.length - maxDiffLines} more lines)`
      : data.diff;

    parts.push("");
    parts.push("### Code Changes (diff)");
    parts.push("```diff");
    parts.push(truncated);
    parts.push("```");
  }

  if (data.comments.length > 0) {
    parts.push("");
    parts.push("### Recent Comments");
    data.comments.forEach((c, i) => {
      parts.push(`${i + 1}. ${c}`);
    });
  }

  parts.push("");
  parts.push("### Task");
  parts.push(userRequest || `Please review this ${data.type} and provide feedback.`);

  return parts.join("\n");
}
