/**
 * GitHub comment management — create/update comments on PRs and issues.
 * Deduplicates by signature so the same comment is reused across pushes.
 * Uses the animated elek spinner from the action's home repo on `main`,
 * so fork PRs (where GITHUB_HEAD_REF doesn't exist in the base repo) work.
 */
import type { GitHubEntityContext } from "../types";
import { spinnerHeader } from "./spinner";

const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || "https://github.com";

// Loose adapter type matching @actions/github's getOctokit return shape.
// Octokit's full types are deeply specific and don't structurally fit a
// hand-rolled minimal interface, so we accept `any` for params + responses
// and access only the fields we actually use.
type GitHubApi = {
  rest: {
    issues: {
      createComment: (params: any) => Promise<any>;
      updateComment: (params: any) => Promise<any>;
      listComments: (params: any) => Promise<any>;
    };
    pulls: {
      createReview: (params: any) => Promise<any>;
      listReviews: (params: any) => Promise<any>;
      listReviewComments: (params: any) => Promise<any>;
    };
  };
};

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
 * Find an existing elek comment for this model on the issue/PR.
 * The signature alone is unique enough — we don't filter by bot login
 * because tokens (default GITHUB_TOKEN, PATs, GitHub Apps) all show up
 * with different `user.login` values. Anyone faking the signature is
 * impersonating the bot, which is itself a bug we'd rather surface than hide.
 *
 * Pages through all comments since long-lived PRs may have many.
 */
async function findExistingComment(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  modelLabel: string,
): Promise<number | undefined> {
  const sig = commentSignature(modelLabel);
  try {
    let page = 1;
    let lastMatchId: number | undefined;
    while (page <= 10) {
      const { data: comments } = await octokit.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.entityNumber,
        per_page: 100,
        page,
      });
      for (const c of comments) {
        if (c.body?.includes(sig)) lastMatchId = c.id;
      }
      if (comments.length < 100) break;
      page++;
    }
    return lastMatchId;
  } catch (err) {
    console.warn("findExistingComment failed:", (err as Error).message);
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
  const sig = commentSignature(modelLabel);
  const body = [
    `${spinnerHeader(modelLabel)} ${sig}`,
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
  await octokit.rest.pulls.createReview({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.entityNumber,
    body: formatReviewBody(output, conclusion, context),
    event: "COMMENT",
  });

  console.log("✓ Posted PR review (COMMENT)");
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
