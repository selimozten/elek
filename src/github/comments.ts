/**
 * GitHub comment management — create/update comments on PRs and issues.
 * Deduplicates by signature so the same comment is reused across pushes.
 */
import type { GitHubEntityContext } from "../types.js";
import { extractFindingIds, stripFindingMarkers } from "../review/finding-markers.js";
import { spinnerHeader } from "./spinner.js";
import { withGitHubRetry } from "./retry.js";
import { createHash } from "crypto";

const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || "https://github.com";
const ELEK_UNSCOPED_COMMENT_SIGNATURE = "<!-- elek-bot -->";
const ELEK_LEGACY_COMMENT_PREFIX = "<!-- elek-bot:";
const ELEK_SUPERSEDED_SIGNATURE = "<!-- elek-bot:superseded -->";
const ELEK_TRACKING_SIGNATURE_RE = /<!--\s*elek-bot(?::[^>]*)?\s*-->/gi;
const ELEK_REVIEW_HEADER_RE = /<p>\s*<strong>elek<\/strong>\s+review:/i;

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

type TrackingCommentKind = "matching" | "unscoped" | "other";
type TrackingComment = {
  id: number;
  htmlUrl?: string;
  body: string;
  kind: TrackingCommentKind;
};

const defaultTrustedCommentAuthors = new Set([
  "github-actions[bot]",
  "elek[bot]",
  "eleksh[bot]",
]);

function jobRunLink(context: GitHubEntityContext): string {
  const runId = process.env.GITHUB_RUN_ID || "?";
  const repo = context.repo.fullName;
  return `[View run](${GITHUB_SERVER_URL}/${repo}/actions/runs/${runId})`;
}

function commentSignature(modelLabel: string): string {
  return `<!-- elek-bot:lane:${trackingLane(modelLabel)} -->`;
}

function trackingLane(modelLabel: string): string {
  return createHash("sha256")
    .update(modelLabel.trim().toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

function classifyTrackingComment(
  body: string | undefined,
  modelLabel: string,
): TrackingCommentKind | undefined {
  if (!body || isSupersededTrackingComment(body)) return undefined;

  const scopedLanes = [...body.matchAll(/<!--\s*elek-bot:lane:([a-f0-9]{12,64})\s*-->/gi)]
    .map((match) => match[1]?.toLowerCase())
    .filter((lane): lane is string => Boolean(lane));
  const scopedLane = scopedLanes.at(-1);
  if (scopedLane) {
    return scopedLane === trackingLane(modelLabel) ? "matching" : "other";
  }

  if (body.includes(ELEK_UNSCOPED_COMMENT_SIGNATURE)) return "unscoped";

  const exactLegacySignature = `<!-- elek-bot:${modelLabel} -->`;
  if (body.includes(exactLegacySignature)) return "matching";
  if (body.includes(ELEK_LEGACY_COMMENT_PREFIX)) return "other";

  return undefined;
}

function isSupersededTrackingComment(body: string | undefined): boolean {
  return Boolean(body?.includes(ELEK_SUPERSEDED_SIGNATURE));
}

function supersededBody(previousBody: string, latestUrl: string | undefined): string {
  const detailsBody =
    previousBody.length > 55_000
      ? `${previousBody.slice(0, 55_000)}\n\n_...previous review truncated while marking it superseded_`
      : previousBody;
  return [
    spinnerHeader("", "superseded by a newer run"),
    "",
    latestUrl
      ? `This Elek review was superseded by [a newer run](${latestUrl}).`
      : "This Elek review was superseded by a newer run.",
    "",
    "<details>",
    "<summary>Previous review content</summary>",
    "",
    detailsBody,
    "",
    "</details>",
    "",
    ELEK_SUPERSEDED_SIGNATURE,
  ].join("\n");
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
async function findTrackingComments(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  modelLabel: string,
): Promise<TrackingComment[]> {
  const matches: TrackingComment[] = [];
  try {
    const trustedAuthors = trustedCommentAuthors();
    let page = 1;
    while (page <= 10) {
      const { data: comments } = await withGitHubRetry(
        () =>
          octokit.rest.issues.listComments({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: context.entityNumber,
            per_page: 100,
            page,
          }),
        { label: "listComments" },
      );
      for (const c of comments) {
        if (!isTrustedCommentAuthor(c, trustedAuthors)) continue;
        const kind = classifyTrackingComment(c.body, modelLabel);
        if (kind) {
          matches.push({ id: c.id, htmlUrl: c.html_url, body: c.body || "", kind });
        }
      }
      if (comments.length < 100) break;
      page++;
    }
    return matches;
  } catch (err) {
    console.warn("findTrackingComments failed:", (err as Error).message);
    return [];
  }
}

function trustedCommentAuthors(): Set<string> {
  const configured = (process.env.ELEK_TRACKING_COMMENT_AUTHORS || "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? new Set(configured) : defaultTrustedCommentAuthors;
}

function isTrustedCommentAuthor(comment: { user?: { login?: string } }, trustedAuthors: Set<string>): boolean {
  const login = comment.user?.login?.toLowerCase();
  return Boolean(login && trustedAuthors.has(login));
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

  // Reuse only this posting lane's newest active comment. Read-only reviewer
  // models never create comments, and other model lanes must not be overwritten
  // by the orchestrator/final model for this run. Old unscoped comments are
  // migrated away from because they are what caused cross-model overwrites.
  const existingComments = await findTrackingComments(octokit, context, modelLabel);
  const selected = existingComments.filter((comment) => comment.kind === "matching").at(-1);
  const supersededAfterUpdate = existingComments.filter((comment) =>
    comment.kind !== "other" && comment.id !== selected?.id
  );

  if (selected) {
    await withGitHubRetry(
      () =>
        octokit.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: selected.id,
          body,
        }),
      { label: "updateComment" },
    );
    await markSupersededTrackingComments(
      octokit,
      context,
      supersededAfterUpdate,
      selected.htmlUrl,
    );
    console.log(`✓ Reused existing comment #${selected.id}`);
    return { id: selected.id, htmlUrl: selected.htmlUrl || "" };
  }

  const { data } = await withGitHubRetry(
    () =>
      octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.entityNumber,
        body,
      }),
    { label: "createComment" },
  );

  console.log(`✓ Created tracking comment #${data.id}`);
  await markSupersededTrackingComments(
    octokit,
    context,
    existingComments.filter((comment) => comment.kind === "unscoped"),
    data.html_url,
  );
  return { id: data.id, htmlUrl: data.html_url };
}

async function markSupersededTrackingComments(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  comments: Array<{ id: number; body: string }>,
  latestUrl: string | undefined,
): Promise<void> {
  for (const comment of comments.slice(-20)) {
    try {
      await withGitHubRetry(
        () =>
          octokit.rest.issues.updateComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            comment_id: comment.id,
            body: supersededBody(comment.body, latestUrl),
          }),
        { label: "markSupersededTrackingComment" },
      );
      console.log(`✓ Marked old elek comment #${comment.id} as superseded`);
    } catch (err) {
      console.warn(`Could not mark old elek comment #${comment.id} as superseded:`, err);
    }
  }
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
  await withGitHubRetry(
    () =>
      octokit.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: commentId,
        body: withCommentSignature(body, modelLabel),
      }),
    { label: "updateTrackingComment" },
  );
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
  await withGitHubRetry(
    () =>
      octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.entityNumber,
        body: withCommentSignature(body, modelLabel),
      }),
    { label: "postComment" },
  );
  console.log("✓ Posted fallback comment");
}

function withCommentSignature(body: string, modelLabel: string): string {
  const cleanedBody = body
    .replace(ELEK_TRACKING_SIGNATURE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return cleanedBody ? `${cleanedBody}\n\n${commentSignature(modelLabel)}` : commentSignature(modelLabel);
}

/**
 * Post a PR review.
 */
export async function createPRReview(
  octokit: GitHubApi,
  context: GitHubEntityContext,
  output: string,
  conclusion: "success" | "failure",
  modelLabel: string,
): Promise<void> {
  await withGitHubRetry(
    () =>
      octokit.rest.pulls.createReview({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.entityNumber,
        body: formatReviewBody(output, conclusion, context, modelLabel),
        event: "COMMENT",
      }),
    { label: "createPRReview" },
  );

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
    const { data: reviews } = await withGitHubRetry(
      () =>
        octokit.rest.pulls.listReviews({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: context.entityNumber,
        }),
      { label: "listReviews" },
    );

    const { data: reviewComments } = await withGitHubRetry(
      () =>
        octokit.rest.pulls.listReviewComments({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: context.entityNumber,
        }),
      { label: "listReviewComments" },
    );

    const comments: string[] = [];

    // Include review bodies
    for (const review of reviews) {
      if (review.body?.trim() && !ELEK_REVIEW_HEADER_RE.test(review.body)) {
        comments.push(`[Review: ${review.state}]: ${review.body.trim()}`);
      }
    }

    // Include inline review comments
    for (const rc of reviewComments) {
      const loc = rc.path ? `${rc.path}:${rc.line || "?"}` : "";
      const ids = extractFindingIds(rc.body);
      if (ids.length > 0) continue;
      comments.push(`[${loc}]: ${stripFindingMarkers(rc.body || "")}`);
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
  modelLabel: string,
): string {
  const runLink = jobRunLink(context);

  return [
    conclusion === "success"
      ? spinnerHeader(modelLabel, "analysis complete")
      : spinnerHeader(modelLabel, "encountered an issue"),
    "",
    output,
    "",
    "---",
    `*${runLink}*`,
  ].join("\n");
}
