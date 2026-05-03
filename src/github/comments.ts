/**
 * GitHub comment management — create/update comments on PRs and issues.
 * Deduplicates: searches for existing bot comment before creating new.
 * Uses custom spinner GIF from repo assets.
 */
import type { GitHubEntityContext } from "../types";

const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || "https://github.com";

const BOT_LOGIN = "github-actions[bot]";

/** Dynamic spinner URL using current branch so it works on PRs too */
function spinnerHtml(): string {
  const repo = process.env.GITHUB_REPOSITORY || "selimozten/elek";
  const ref = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "main";
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/assets/spinner.gif`;
  return `<img src="${url}" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />`;
}

interface GitHubApi {
  rest: {
    issues: {
      createComment(params: any): Promise<{ data: { id: number; html_url: string } }>;
      updateComment(params: any): Promise<{ data: { id: number; html_url: string } }>;
      listComments(params: any): Promise<{ data: Array<{ id: number; user?: { login?: string; type?: string }; body?: string }> }>;
    };
    pulls: {
      createReview(params: any): Promise<{ data: { id: number; html_url: string } }>;
      listReviews(params: any): Promise<{ data: Array<{ id: number; body?: string; state?: string }> }>;
      listReviewComments(params: any): Promise<{ data: Array<{ id: number; user?: { login?: string }; body?: string; path?: string; line?: number }> }>;
    };
  };
}

function jobRunLink(context: GitHubEntityContext): string {
  const runId = process.env.GITHUB_RUN_ID || "?";
  const repo = context.repo.fullName;
  return `[View run](${GITHUB_SERVER_URL}/${repo}/actions/runs/${runId})`;
}

/** Model-specific signature so dual reviews don't collide */
function commentSignature(modelLabel: string): string {
  return `<!-- elek-bot:${modelLabel} -->`;
}

/**
 * Find an existing elek bot comment for a specific model.
 * Returns the comment ID if found, undefined otherwise.
 */
async function findExistingComment(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  modelLabel: string,
): Promise<number | undefined> {
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.entityNumber,
      per_page: 50,
    });

    const sig = commentSignature(modelLabel);
    const existing = comments.findLast(
      (c) =>
        c.user?.login === BOT_LOGIN &&
        c.body?.includes(sig),
    );

    return existing?.id;
  } catch {
    return undefined;
  }
}

/**
 * Create or reuse a tracking comment.
 * If an existing bot comment is found, updates it. Otherwise creates new.
 */
export async function createTrackingComment(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  modelLabel: string,
): Promise<{ id: number; htmlUrl: string }> {
  const runLink = jobRunLink(context);
  const spin = spinnerHtml();

  const sig = commentSignature(modelLabel);
  const body = [
    `${spin} **${modelLabel}** analyzing…  ${sig}`,
    "",
    `Reviewing this ${context.isPR ? "pull request" : "issue"}, this may take a minute.`,
    "",
    runLink,
  ].join("\n");

  // Check for existing comment to reuse (model-specific)
  const existingId = await findExistingComment(octokit, context, modelLabel);

  if (existingId) {
    await octokit.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existingId,
      body,
    });
    console.log(`✓ Reused existing comment #${existingId}`);
    return { id: existingId, htmlUrl: "" };
  }

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
  modelLabel: string,
): Promise<void> {
  const sig = commentSignature(modelLabel);
  await octokit.rest.issues.updateComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    comment_id: commentId,
    body: body + "\n\n" + sig,
  });
}

/**
 * Post a new standalone comment (fallback when update fails).
 */
export async function postComment(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  body: string,
  modelLabel: string,
): Promise<void> {
  const sig = commentSignature(modelLabel);
  await octokit.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.entityNumber,
    body: body + "\n\n" + sig,
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

/**
 * Fetch PR review comments for context inclusion.
 */
export async function fetchReviewComments(
  octokit: GitHubApi,
  context: GitHubEntityContext,
): Promise<string[]> {
  if (!context.isPR) return [];

  try {
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.entityNumber,
    });

    const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.entityNumber,
    });

    const comments: string[] = [];

    // Include review bodies
    for (const review of reviews) {
      if (review.body?.trim()) {
        comments.push(`[Review: ${review.state}]: ${review.body.trim()}`);
      }
    }

    // Include inline review comments
    for (const rc of reviewComments) {
      const loc = rc.path ? `${rc.path}:${rc.line || "?"}` : "";
      comments.push(`[${loc}]: ${rc.body || ""}`);
    }

    return comments;
  } catch {
    return [];
  }
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
