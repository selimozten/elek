#!/usr/bin/env node
/**
 * elek — read-only AI code review for pull requests.
 *
 *  1. Parse the pull_request event and decide whether it gets a review
 *  2. Load .elek.yml policy from the base branch
 *  3. Build the prompt from the PR diff and conversation
 *  4. Run one read-only pi session, streaming progress to a tracking comment
 *  5. Post the sanitized review and inline findings
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { parseInputs, parseEntityContext } from "../github/context.js";
import {
  applyConfigDefaults,
  formatConfigAuditLog,
  loadBaseBranchElekConfig,
  loadBaseBranchRepoKnowledge,
  loadElekConfig,
  loadRepoKnowledge,
  mergeBasePolicyWithWorkspaceGuidance,
} from "../config.js";
import { isActorAuthorized, shouldReview } from "../github/trigger.js";
import { credentialPreflight } from "../credentials.js";
import { fetchGitHubData, buildPrompt } from "../github/data.js";
import { postBuffered, type PostSummary } from "./post-buffered.js";
import {
  createTrackingComment,
  updateTrackingComment,
  createPRReview,
  postComment,
  fetchReviewComments,
} from "../github/comments.js";
import { runPi, type ProgressEvent } from "../pi.js";
import { formatProgressComment, type ProgressState } from "../github/progress.js";
import { spinnerHeader } from "../github/spinner.js";
import type { PiRunResult } from "../types.js";
import {
  buildSingleSessionReviewRequest,
  resolveReviewPlan,
  resolveReviewPlanSupport,
} from "../review/strategy.js";
import { reviewPromptForAttempt, runPiWithTransientRecovery } from "../review/run-recovery.js";
import {
  aggregateCosts,
  costFromPiResult,
  formatCostLine,
  modelLabelFor,
  type ReviewCost,
} from "../review/cost.js";
import { parseReviewFindings } from "../review/findings.js";
import { preparePublicReviewOutput, reviewConclusion } from "../review/public-output.js";
import { inlineReviewBufferFromFindings } from "../review/inline-fallback.js";
import { sanitize } from "../review/host-output.js";

/** Request used when the workflow does not set a prompt. */
const DEFAULT_REVIEW_REQUEST =
  "Review this pull request for correctness, security, performance, and " +
  "maintainability. Reference specific files and lines.";

function skip(message: string): void {
  console.log(message);
  core.setOutput("conclusion", "skipped");
  core.setOutput("summary", message);
}

async function run(): Promise<void> {
  // ── Phase 0: Parse inputs & context ──────────────────────────────────
  core.setOutput("cost_usd", "0.000000");
  core.setOutput("input_tokens", "0");
  core.setOutput("output_tokens", "0");

  const parsedInputs = parseInputs();
  const context = parseEntityContext();

  if (!context) {
    const message = `elek reviews pull_request events only; ignoring ${process.env.GITHUB_EVENT_NAME}.`;
    core.warning(message);
    skip(message);
    return;
  }

  console.log(`Event: pull_request.${context.eventAction} | PR #${context.entityNumber} by @${context.actor}`);

  // ── Phase 1: Gate ────────────────────────────────────────────────────
  if (!shouldReview(context)) {
    skip(
      context.pr.draft
        ? "Draft pull request; elek reviews it once it is marked ready."
        : `No review for pull_request.${context.eventAction}.`,
    );
    return;
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    core.setFailed("GITHUB_TOKEN not available");
    return;
  }

  const octokit = github.getOctokit(githubToken);
  const actorAllowed = await isActorAuthorized(context, async ({ owner, repo, actor }) => {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: actor,
    });
    return data.permission;
  });

  if (!actorAllowed) {
    skip(
      `Actor @${context.actor} not allowed ` +
        `(webhook association: ${context.actorAssociation || "unknown"}).`,
    );
    return;
  }

  // Before any GitHub writes: a fork run has a read-only token and no
  // secrets, so a tracking comment would 403 and Pi would fail on auth.
  const credentials = credentialPreflight({
    provider: parsedInputs.provider,
    env: process.env,
    rawEventName: process.env.GITHUB_EVENT_NAME,
    isForkPR: context.pr.isFork === true,
  });
  if (credentials.action === "skip") {
    core.notice(credentials.message);
    skip(credentials.message);
    return;
  }
  if (credentials.action === "fail") {
    core.setOutput("conclusion", "failure");
    core.setOutput("summary", credentials.message);
    core.setFailed(credentials.message);
    return;
  }

  // ── Phase 2: Config ──────────────────────────────────────────────────
  // Policy and knowledge come from the base branch so a PR cannot weaken
  // its own review.
  const warnConfig = (message: string) => console.warn(`[config] ${message}`);
  const workspaceConfig = loadElekConfig(parsedInputs.configPath, warnConfig);
  const baseConfig = loadBaseBranchElekConfig(parsedInputs.configPath, context.pr.baseRef, warnConfig);
  const repoConfig = baseConfig.loaded
    ? loadBaseBranchRepoKnowledge(
      mergeBasePolicyWithWorkspaceGuidance(baseConfig.config, workspaceConfig),
      context.pr.baseRef,
      warnConfig,
    )
    : loadRepoKnowledge(workspaceConfig, warnConfig);
  const inputs = applyConfigDefaults(parsedInputs, repoConfig);
  const ignoredOneSessionSettings = [
    inputs.reviewModels && "review_models",
    inputs.reviewAgentCount !== undefined && "review_agent_count",
    inputs.advisorModel && "advisor_model",
    inputs.advisorThinking && "advisor_thinking",
    inputs.validatorModel && "validator_model",
    inputs.validatorThinking && "validator_thinking",
    inputs.maxCostUsd !== undefined && "max_cost_usd",
  ].filter(Boolean);
  if (ignoredOneSessionSettings.length > 0) {
    console.warn(`[config] Ignoring obsolete one-session settings: ${ignoredOneSessionSettings.join(", ")}`);
  }
  const effectiveRepoConfig = {
    ...repoConfig,
    severityThreshold: inputs.severityThreshold || repoConfig.severityThreshold,
  };
  console.log(formatConfigAuditLog(
    parsedInputs.configPath,
    effectiveRepoConfig,
    inputs,
    baseConfig.loaded ? "base-branch-policy+base-branch-knowledge" : "checked-out-guidance-only",
  ));

  const userRequest = inputs.prompt || DEFAULT_REVIEW_REQUEST;

  // ── Phase 3: Fetch data ──────────────────────────────────────────────
  const modelLabel = modelLabelFor(inputs);
  const runId = process.env.GITHUB_RUN_ID || "?";
  const jobRunLink = `https://github.com/${context.repo.fullName}/actions/runs/${runId}`;

  const reviewPlan = resolveReviewPlan(inputs);
  const reviewPlanSupport = resolveReviewPlanSupport(reviewPlan.strategy);

  const data = await fetchGitHubData(context, octokit);
  try {
    data.reviewComments = await fetchReviewComments(octokit, context);
  } catch (err) {
    console.warn("Could not fetch review comments:", err);
  }

  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const promptDir = join(tmpDir, "pi-prompts");
  mkdirSync(promptDir, { recursive: true });

  // ── Phase 4: Run pi with progressive updates ─────────────────────────
  console.log("── Running pi ──");

  const progress: ProgressState = {
    readContext: false,
    analyzed: false,
    wroteReview: false,
    lastTool: "",
  };

  // State machine driven by what pi actually emits:
  //   1st tool_start            → "Read context" ✓
  //   2nd+ tool_start            → "Analyzed code" ✓ (still working)
  //   text_delta after tools     → still in "Writing review…" — don't tick the box
  //   "done" (run finished)      → "Review complete" ✓
  let toolsSeen = 0;
  let textStreamed = false;
  let commentId: number | undefined;

  let lastUpdate = 0;
  let lastBody = "";
  const onProgress = async (event: ProgressEvent) => {
    if (event.type === "tool_start") {
      toolsSeen++;
      if (toolsSeen === 1) progress.readContext = true;
      if (toolsSeen >= 2) progress.analyzed = true;
      if (event.detail) progress.lastTool = event.detail;
    } else if (event.type === "text") {
      // Model is generating the answer → context+analysis are implicitly done
      progress.readContext = true;
      progress.analyzed = true;
      textStreamed = true;
    } else if (event.type === "done") {
      progress.readContext = true;
      progress.analyzed = true;
      progress.wroteReview = textStreamed;
    }

    if (!commentId) return;

    // Rate-limit to avoid GitHub API abuse, but always flush the "done" event.
    const now = Date.now();
    const isFinal = event.type === "done";
    if (!isFinal && now - lastUpdate < 3000) return;

    const body = formatProgressComment(progress, modelLabel, jobRunLink);
    if (body === lastBody && !isFinal) return; // no visible change → skip the API call
    lastUpdate = now;
    lastBody = body;
    try {
      await updateTrackingComment(octokit, context, commentId, body, modelLabel);
    } catch (err) {
      console.warn("progress update failed:", (err as Error).message);
    }
  };

  const useReviewPlan = reviewPlanSupport.enabled;
  console.log(`[config] execution_strategy=${useReviewPlan ? reviewPlan.strategy : "solo"}-single-session`);

  if (inputs.stickyComment) {
    try {
      const comment = await createTrackingComment(octokit, context, modelLabel);
      commentId = comment.id;
    } catch (err) {
      console.warn("Could not create tracking comment:", err);
    }
  }

  const prompt = buildPrompt(
    data,
    useReviewPlan ? buildSingleSessionReviewRequest(userRequest, reviewPlan) : userRequest,
    modelLabel,
    commentId,
    { repoConfig: effectiveRepoConfig },
  );
  writeFileSync(join(promptDir, "prompt.md"), prompt, "utf-8");

  const runCosts: ReviewCost[] = [];

  if (useReviewPlan) {
    console.log(
      `Review strategy: ${reviewPlan.strategy} | lenses: ${reviewPlan.jobs
        .map((job) => job.lens.id)
        .join(", ")} | model: ${modelLabel} | one pi session`,
    );

    if (commentId) {
      try {
        await updateTrackingComment(
          octokit,
          context,
          commentId,
          [
            spinnerHeader(modelLabel, `running ${reviewPlan.strategy} review`),
            "",
            ...reviewPlan.jobs.map((j) => `- ${j.lens.title}`),
            "",
            "Single-session Ponytail validation and posting",
            `[View run](${jobRunLink})`,
          ].join("\n"),
          modelLabel,
        );
      } catch (err) {
        console.warn("Could not update strategy status:", err);
      }
    }
  }

  let result: PiRunResult = {
    conclusion: "failure",
    output: "Review execution failed",
    turnsUsed: 0,
    providerRetries: 0,
    durationSeconds: 0,
    costUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      estimated: true,
      modelLabel,
      source: "unknown",
    },
  };
  const finalCostIndex = runCosts.push(costFromPiResult(result)) - 1;
  try {
    result = await runPiWithTransientRecovery(
      (attempt) => runPi(
        reviewPromptForAttempt(prompt, attempt),
        inputs,
        onProgress,
        { promptName: "prompt" },
      ),
    );
    runCosts[finalCostIndex] = costFromPiResult(result);
  } catch (err) {
    result = {
      ...result,
      output: `Review execution failed: ${(err as Error).message}`,
    };
  }

  console.log(`── pi ${result.conclusion === "success" ? "completed" : "failed"} ──`);
  const safeOutput = sanitize(result.output);
  const publicReview = preparePublicReviewOutput(result.output, result.conclusion);
  const publicOutput = publicReview.body;
  const publicConclusion =
    result.conclusion === "success" && publicReview.usable ? "success" : "failure";
  if (publicReview.filtered) {
    console.warn(
      `[review-output] filtered internal delivery text from public review ` +
      `(removed_paragraphs=${publicReview.removedParagraphs})`,
    );
  }
  const parsedFindings = parseReviewFindings(publicOutput);
  const costTotal = aggregateCosts(runCosts);
  const costLine = inputs.showCost ? formatCostLine(costTotal) : "";
  if (result.output) {
    console.log(safeOutput.substring(0, 500) + (safeOutput.length > 500 ? "..." : ""));
  }
  if (inputs.showCost) console.log(costLine);

  // ── Phase 5: Post the review ─────────────────────────────────────────
  // GitHub's hard limit on issue/PR comments is 65,536 chars; leave
  // headroom for the wrapper (header, signature, links).
  const MAX_REVIEW_CHARS = 60_000;
  const truncate = (s: string) =>
    s.length > MAX_REVIEW_CHARS
      ? `${s.slice(0, MAX_REVIEW_CHARS)}\n\n_…review truncated, ${s.length - MAX_REVIEW_CHARS} chars omitted_`
      : s;

  let reviewBody = "";
  let reviewDelivered = false;
  if (commentId) {
    reviewBody = [
      publicConclusion === "success"
        ? spinnerHeader(modelLabel, "analysis complete")
        : spinnerHeader(modelLabel, "encountered an issue"),
      "",
      truncate(publicOutput),
      ...(inputs.showCost ? ["", `_${costLine}_`] : []),
      "",
      `[View run](${jobRunLink})`,
    ].join("\n");

    try {
      await updateTrackingComment(octokit, context, commentId, reviewBody, modelLabel);
      reviewDelivered = true;
    } catch (err) {
      console.warn("Could not update tracking comment, posting new one:", err);
      try {
        await postComment(octokit, context, reviewBody, modelLabel);
        reviewDelivered = true;
      } catch (err2) {
        console.warn("Could not post comment either:", err2);
      }
    }
  } else {
    try {
      const reviewOutput = inputs.showCost
        ? `${truncate(publicOutput)}\n\n_${costLine}_`
        : truncate(publicOutput);
      await createPRReview(octokit, context, reviewOutput, publicConclusion, modelLabel);
      reviewDelivered = true;
    } catch (err) {
      console.warn("Could not create PR review:", err);
    }
  }

  // ── Phase 5b: Post structured inline findings ────────────────────────
  let inlineSummary: PostSummary = { posted: 0, skipped: 0, failed: 0 };
  const inlineBuffer = inlineReviewBufferFromFindings(parsedFindings);
  if (inlineBuffer.trim()) {
    try {
      inlineSummary = await postBuffered({
        readBuffer: () => inlineBuffer,
        octokit: octokit.rest,
        env: {
          repoOwner: context.repo.owner,
          repoName: context.repo.repo,
          prNumber: String(context.entityNumber),
        },
        log: (m) => console.log(`[post-findings] ${m}`),
      });
      console.log(
        `[post-findings] posted=${inlineSummary.posted} skipped=${inlineSummary.skipped} failed=${inlineSummary.failed}`,
      );
    } catch (err) {
      console.warn("post-findings failed:", (err as Error).message);
    }
  }

  if (commentId && reviewBody && (inlineSummary.duplicate ?? 0) > 0) {
    const duplicateNote =
      `_Inline lifecycle: skipped ${inlineSummary.duplicate} duplicate Elek inline finding(s) ` +
      "already visible on this PR._";
    try {
      await updateTrackingComment(
        octokit,
        context,
        commentId,
        [reviewBody, "", duplicateNote].join("\n"),
        modelLabel,
      );
    } catch (err) {
      console.warn("Could not update tracking comment with inline lifecycle note:", err);
    }
  }

  // ── Phase 6: Set outputs ─────────────────────────────────────────────
  const finalConclusion = reviewConclusion(result.conclusion, publicReview.usable, reviewDelivered);
  core.setOutput("conclusion", finalConclusion);
  core.setOutput("comment_id", commentId ? String(commentId) : "");
  core.setOutput("session_id", result.sessionId || "");
  core.setOutput("summary", publicOutput.substring(0, 1000));
  core.setOutput("cost_usd", costTotal.costUsd.toFixed(6));
  core.setOutput("input_tokens", String(costTotal.inputTokens));
  core.setOutput("output_tokens", String(costTotal.outputTokens));

  if (finalConclusion === "failure") {
    core.setFailed(
      result.conclusion === "failure"
        ? `pi execution failed${result.errorKind ? ` (${result.errorKind})` : ""}`
        : !publicReview.usable
          ? "pi returned no usable public review"
          : "review could not be delivered to GitHub",
    );
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  core.setFailed(`Fatal: ${err.message}`);
  process.exit(1);
});
