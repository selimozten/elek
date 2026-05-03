/**
 * GitHub comment management — create/update comments on PRs and issues.
 * Templates match Claude Code Action: spinner HTML, job run links, clean structure.
 */
import type { GitHubEntityContext } from "../types";

const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || "https://github.com";

/** Spinner HTML used in Claude Code Action */
const SPINNER =
  '<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />';

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

function jobRunLink(context: GitHubEntityContext): string {
  const runId = process.env.GITHUB_RUN_ID || "?";
  const repo = context.repo.fullName;
  const url = `${GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}`;
  return `[View run](${url})`;
}

/**
 * Create the initial tracking comment — styled like Claude's.
 */
export async function createTrackingComment(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  modelLabel: string,
): Promise<{ id: number; htmlUrl: string }> {
  const runLink = jobRunLink(context);

  const body = [
    `${SPINNER} **${modelLabel}** analyzing…`,
    "",
    `Reviewing this ${context.isPR ? "pull request" : "issue"}, this may take a minute.`,
    "",
    runLink,
  ].join("\n");

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
 * Update an existing tracking comment.
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
 * Post a new standalone comment (fallback when update fails).
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
  console.log("✓ Posted fallback comment");
}

/**
 * Post a PR review.
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
    body: formatReviewBody(output, conclusion, context),
    event,
  });

  console.log(`✓ Posted PR review (${event})`);
}

function formatReviewBody(
  output: string,
  conclusion: "success" | "failure",
  context: GitHubEntityContext,
): string {
  const icon = conclusion === "success" ? "✅" : "⚠️";
  const runLink = jobRunLink(context);

  return [
    `${icon} **Review complete**`,
    "",
    output,
    "",
    "---",
    `*${runLink}*`,
  ].join("\n");
}
