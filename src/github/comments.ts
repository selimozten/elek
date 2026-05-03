/**
 * GitHub comment management — create/update comments on PRs and issues.
 */
import type { GitHubEntityContext } from "../types";

interface GitHubApi {
  rest: {
    issues: {
      createComment(params: any): Promise<{ data: { id: number; html_url: string } }>;
      updateComment(params: any): Promise<{ data: { id: number; html_url: string } }>;
    };
    pulls: {
      createReview(params: any): Promise<{ data: { id: number; html_url: string } }>;
    };
  };
}

/**
 * Create an initial tracking comment on a PR or issue.
 * Returns the comment ID for later updates.
 */
export async function createTrackingComment(
  octokit: GitHubApi,
  context: GitHubEntityContext,
): Promise<{ id: number; htmlUrl: string }> {
  const body = buildInitialComment(context);

  const { data } = await octokit.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.entityNumber,
    body,
  });

  console.log(`✓ Created tracking comment #${data.id}`);
  return { id: data.id, htmlUrl: data.html_url };
}

/**
 * Update an existing tracking comment with new content.
 */
export async function updateTrackingComment(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.updateComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    comment_id: commentId,
    body,
  });
}

/**
 * Post a PR review with the pi output.
 */
export async function createPRReview(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  output: string,
  conclusion: "success" | "failure",
): Promise<void> {
  const event = conclusion === "success" ? "COMMENT" : "REQUEST_CHANGES";

  await octokit.rest.pulls.createReview({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.entityNumber,
    body: formatReviewBody(output, conclusion),
    event,
  });

  console.log(`✓ Posted PR review (${event})`);
}

/**
 * Post a simple comment (non-tracking).
 */
export async function postComment(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.entityNumber,
    body,
  });

  console.log("✓ Posted comment");
}

function buildInitialComment(context: GitHubEntityContext): string {
  const runId = process.env.GITHUB_RUN_ID || "?";
  const runUrl = `https://github.com/${context.repo.fullName}/actions/runs/${runId}`;

  return [
    "🤖 **pi is analyzing...**",
    "",
    `Triggered by @${context.actor} on this ${context.isPR ? "pull request" : "issue"}.`,
    "",
    "[View run](" + runUrl + ") · Waiting for analysis to complete...",
    "",
    "---",
    "*This comment will update when analysis is complete.*",
  ].join("\n");
}

function formatReviewBody(output: string, conclusion: "success" | "failure"): string {
  const icon = conclusion === "success" ? "✅" : "⚠️";
  const runId = process.env.GITHUB_RUN_ID || "?";
  const repo = process.env.GITHUB_REPOSITORY || "?";
  const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;

  return [
    `${icon} **pi review ${conclusion === "success" ? "complete" : "completed with issues"}**`,
    "",
    output,
    "",
    "---",
    `*Powered by [pi coding agent](https://github.com/badlogic/pi-mono) · [View run](${runUrl})*`,
  ].join("\n");
}
