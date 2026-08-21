#!/usr/bin/env node
/**
 * elek — Model-agnostic AI code review for GitHub.
 * Sift through PRs and issues with pi coding agent.
 *
 * Orchestrates:
 *  1. Parse GitHub event context
 *  2. Detect trigger conditions (@pi mentions, explicit prompts)
 *  3. Fetch GitHub data (PR diff, issue body)
 *  4. Run pi with the built prompt
 *  5. Post results back to GitHub (comments, reviews)
 *  6. Handle git branches for code changes
 *
 * No MCP servers, no bun, no vendor lock-in. Just pi and a few modules.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

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
import { detectTrigger, isActorAuthorized } from "../github/trigger.js";
import { fetchGitHubData, buildPrompt } from "../github/data.js";
import { resolveMode, resolvePiTools } from "../github/mode.js";
import { postBuffered } from "./post-buffered.js";
import {
  configureGitAuth,
  createElekBranch,
  commitChanges,
  pushBranch,
} from "../github/git.js";
import {
  createTrackingComment,
  updateTrackingComment,
  createPRReview,
  postComment,
  fetchReviewComments,
} from "../github/comments.js";
import { runPi } from "../pi.js";
import type { ProgressEvent } from "../pi.js";
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
import {
  buildReviewSummary,
  metricFromPiRun,
  type ReviewRunMetric,
} from "../review/summary.js";
import { parseReviewFindings } from "../review/findings.js";
import { preparePublicReviewOutput, reviewConclusion } from "../review/public-output.js";
import { modelLabelRedactionTerms, publicModelLabelFor } from "../review/public-label.js";
import { inlineReviewBufferFromFindings } from "../review/inline-fallback.js";
import { sanitize } from "../review/host-output.js";
import type { PostSummary } from "./post-buffered.js";

async function run(): Promise<void> {
  // ── Phase 0: Parse inputs & context ──────────────────────────────────
  core.setOutput("cost_usd", "0.000000");
  core.setOutput("input_tokens", "0");
  core.setOutput("output_tokens", "0");
  core.setOutput("review_summary_path", "");
  core.setOutput("review_summary_json", "");

  const actionStartedAt = new Date();
  const parsedInputs = parseInputs();
  const context = parseEntityContext();

  if (!context) {
    core.setFailed(`Unsupported event: ${process.env.GITHUB_EVENT_NAME}`);
    return;
  }

  console.log(
    `Event: ${context.eventName}.${context.eventAction} | ` +
      `${context.isPR ? "PR" : "Issue"} #${context.entityNumber} by @${context.actor}`,
  );

  // ── Phase 1: Trigger detection ───────────────────────────────────────
  const userRequest = detectTrigger(context, parsedInputs);

  if (!userRequest) {
    console.log("No trigger detected — exiting cleanly");
    core.setOutput("conclusion", "skipped");
    core.setOutput("summary", "No trigger detected");
    return;
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    core.setFailed("GITHUB_TOKEN not available");
    return;
  }

  const octokit = github.getOctokit(githubToken);
  const actorAllowed = await isActorAuthorized(
    context,
    parsedInputs,
    async ({ owner, repo, actor }) => {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: actor,
      });
      return data.permission;
    },
  );

  if (!actorAllowed) {
    console.log(
      `Actor @${context.actor} not allowed ` +
        `(webhook association: ${context.actorAssociation || "unknown"}) — exiting`,
    );
    core.setOutput("conclusion", "skipped");
    core.setOutput("summary", `Actor @${context.actor} not authorized`);
    return;
  }

  let configBaseRef = context.pr?.baseRef || context.repo.defaultBranch;
  let canLoadBasePolicy = !context.isPR || Boolean(context.pr?.baseRef);
  if (context.isPR && !context.pr?.baseRef) {
    try {
      const { data: pr } = await octokit.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.entityNumber,
      });
      configBaseRef = pr.base?.ref || configBaseRef;
      canLoadBasePolicy = Boolean(pr.base?.ref);
      if (context.pr) {
        context.pr = {
          title: pr.title || context.pr.title,
          body: pr.body || context.pr.body,
          headRef: pr.head?.ref || context.pr.headRef,
          baseRef: pr.base?.ref || context.pr.baseRef,
          headSha: pr.head?.sha || context.pr.headSha,
          baseSha: pr.base?.sha || context.pr.baseSha,
        };
      }
    } catch (err) {
      canLoadBasePolicy = false;
      console.warn(`[config] Could not resolve PR base ref; skipping base branch policy: ${(err as Error).message}`);
    }
  }

  const workspaceConfig = loadElekConfig(parsedInputs.configPath, (message) => {
    console.warn(`[config] ${message}`);
  });
  const baseConfig = context.isPR
    ? canLoadBasePolicy
      ? loadBaseBranchElekConfig(
        parsedInputs.configPath,
        configBaseRef,
        (message) => console.warn(`[config] ${message}`),
      )
      : { config: { ignorePaths: [], instructions: [] }, loaded: false }
    : undefined;
  const repoConfig = baseConfig?.loaded
    ? mergeBasePolicyWithWorkspaceGuidance(baseConfig.config, workspaceConfig)
    : workspaceConfig;
  const repoConfigWithKnowledge = context.isPR && baseConfig?.loaded
    ? loadBaseBranchRepoKnowledge(repoConfig, configBaseRef, (message) => {
      console.warn(`[config] ${message}`);
    })
    : loadRepoKnowledge(repoConfig, (message) => {
      console.warn(`[config] ${message}`);
    });
  const inputs = applyConfigDefaults(parsedInputs, repoConfigWithKnowledge);
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
    ...repoConfigWithKnowledge,
    severityThreshold: inputs.severityThreshold || repoConfigWithKnowledge.severityThreshold,
  };
  console.log(formatConfigAuditLog(
    parsedInputs.configPath,
    effectiveRepoConfig,
    inputs,
    context.isPR
      ? baseConfig?.loaded
        ? "base-branch-policy+base-branch-knowledge"
        : "checked-out-guidance-only"
      : undefined,
  ));

  console.log(
    `Triggered: "${userRequest.substring(0, 120)}${userRequest.length > 120 ? "..." : ""}"`,
  );

  // ── Phase 2: Setup ───────────────────────────────────────────────────
  const modelLabel = modelLabelFor(inputs);
  const publicModelLabel = publicModelLabelFor(modelLabel);
  const runId = process.env.GITHUB_RUN_ID || "?";
  const jobRunLink = `https://github.com/${context.repo.fullName}/actions/runs/${runId}`;

  // Resolve mode → native pi tool allowlist.
  const resolvedMode = resolveMode(inputs.mode);
  const piTools = resolvePiTools(resolvedMode, inputs.tools);
  console.log(`Mode: ${resolvedMode.mode} | tools: ${piTools}`);
  if (resolvedMode.mode === "review+edit" && !resolvedMode.allowEdit) {
    console.warn("mode=review+edit is currently review-only until sandboxed file tools are available.");
  }
  if (resolvedMode.allowEdit) {
    configureGitAuth(githubToken, context);
  }
  const piInputs = { ...inputs, tools: piTools };

  const reviewPlan = resolveReviewPlan(inputs);
  const reviewPlanSupport = resolveReviewPlanSupport(reviewPlan.strategy, {
    isPR: context.isPR,
    mode: resolvedMode.mode,
  });
  if (reviewPlanSupport.warning) console.warn(reviewPlanSupport.warning);

  const trackingModelLabel = modelLabel;

  // Determine base branch
  const baseBranch =
    inputs.baseBranch || context.pr?.baseRef || context.repo.defaultBranch;

  // Create an elek work branch for code changes (PRs only)
  let workBranch: string | undefined;
  if (context.isPR && resolvedMode.allowEdit) {
    workBranch = createElekBranch(context, inputs.branchPrefix);
  }

  // Defer sticky-comment creation until after strategy size/cost selection so
  // the hidden lane signature matches the final posting model from the start.
  let commentId = parseExistingTrackingCommentId(process.env.ELEK_TRACKING_COMMENT_ID);

  // ── Phase 3: Fetch data & build prompt ───────────────────────────────
  const data = await fetchGitHubData(context, octokit);

  // Include PR review comments for context
  if (context.isPR) {
    try {
      data.reviewComments = await fetchReviewComments(octokit, context);
    } catch (err) {
      console.warn("Could not fetch review comments:", err);
    }
  }

  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const promptDir = join(tmpDir, "pi-prompts");
  mkdirSync(promptDir, { recursive: true });
  let prompt = "";

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
  let activeModelLabel = trackingModelLabel;

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

    const body = formatProgressComment(progress, activeModelLabel, jobRunLink);
    if (body === lastBody && !isFinal) return; // no visible change → skip the API call
    lastUpdate = now;
    lastBody = body;
    try {
      await updateTrackingComment(octokit, context, commentId, body, trackingModelLabel);
    } catch (err) {
      console.warn("progress update failed:", (err as Error).message);
    }
  };

  const useReviewPlan = reviewPlanSupport.enabled;
  activeModelLabel = modelLabel;
  console.log(`[config] execution_strategy=${useReviewPlan ? reviewPlan.strategy : "solo"}-single-session`);

  if (inputs.stickyComment) {
    if (commentId) {
      console.log(`Using existing elek tracking comment #${commentId}`);
    } else {
      try {
        const comment = await createTrackingComment(octokit, context, trackingModelLabel);
        commentId = comment.id;
      } catch (err) {
        console.warn("Could not create tracking comment:", err);
      }
    }
  }

  prompt = buildPrompt(
    data,
    useReviewPlan
      ? buildSingleSessionReviewRequest(userRequest, reviewPlan)
      : userRequest,
    modelLabel,
    jobRunLink,
    commentId,
    {
      allowEdit: resolvedMode.allowEdit,
      tools: piTools,
      repoConfig: effectiveRepoConfig,
      publicModelLabel,
    },
  );
  writeFileSync(join(promptDir, "prompt.md"), prompt, "utf-8");

  const runCosts: ReviewCost[] = [];
  const runMetrics: ReviewRunMetric[] = [];

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
          trackingModelLabel,
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
      modelLabel: activeModelLabel,
      source: "unknown",
    },
  };
  const finalCostIndex = runCosts.push(costFromPiResult(result)) - 1;
  try {
    result = await runPiWithTransientRecovery(
      (attempt) => runPi(
        reviewPromptForAttempt(prompt, attempt),
        piInputs,
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
  const publicReview = preparePublicReviewOutput(result.output, result.conclusion, {
    internalModelLabels: modelLabelRedactionTerms([
      modelLabel,
      inputs.model,
      trackingModelLabel,
      activeModelLabel,
    ]),
    publicModelLabel,
  });
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
  runMetrics.push(metricFromPiRun(result, "validator"));
  const costTotal = aggregateCosts(runCosts);
  const costLine = inputs.showCost ? formatCostLine(costTotal) : "";
  if (result.output) {
    console.log(safeOutput.substring(0, 500) + (safeOutput.length > 500 ? "..." : ""));
  }
  if (inputs.showCost) console.log(costLine);

  // ── Phase 5: Handle results ──────────────────────────────────────────
  // GitHub's hard limit on issue/PR comments is 65,536 chars; leave
  // headroom for the wrapper (header, signature, links).
  const MAX_REVIEW_CHARS = 60_000;
  const truncate = (s: string) =>
    s.length > MAX_REVIEW_CHARS
      ? `${s.slice(0, MAX_REVIEW_CHARS)}\n\n_…review truncated, ${s.length - MAX_REVIEW_CHARS} chars omitted_`
      : s;

  // Always post the review comment first (before git ops, which can fail)
  let reviewBody = "";
  let reviewDelivered = false;
  if (commentId) {
    reviewBody = [
      publicConclusion === "success"
        ? spinnerHeader(activeModelLabel, "analysis complete")
        : spinnerHeader(activeModelLabel, "encountered an issue"),
      "",
      truncate(publicOutput),
      ...(inputs.showCost ? ["", `_${costLine}_`] : []),
      "",
      `[View run](${jobRunLink})`,
    ].join("\n");

    try {
      await updateTrackingComment(octokit, context, commentId, reviewBody, trackingModelLabel);
      reviewDelivered = true;
    } catch (err) {
      console.warn("Could not update tracking comment, posting new one:", err);
      try {
        await postComment(octokit, context, reviewBody, trackingModelLabel);
        reviewDelivered = true;
      } catch (err2) {
        console.warn("Could not post comment either:", err2);
      }
    }
  }

  // Then handle any code changes pi made (separate from the review comment)
  if (result.conclusion === "success" && workBranch) {
    try {
      // Only count non-lockfile changes as elek's work
      // Filter in JS instead of grep -v to avoid exit code 1 when no matches
      const status = execSync("git status --porcelain", {
        encoding: "utf-8",
        stdio: "pipe",
      });

      const relevantChanges = status
        .split("\n")
        .filter((line) => {
          if (!line) return false;
          // Filter out npm install artifacts by exact path prefix, not substring
          const parts = line.trim().split(/\s+/);
          const path = parts.length >= 2 ? parts.slice(1).join(" ") : line;
          return !path.startsWith("package-lock.json") && !path.startsWith("node_modules/");
        })
        .join("\n");

      if (relevantChanges.trim()) {
        commitChanges(`chore(elek): automated changes for #${context.entityNumber}`);
        pushBranch(workBranch);

        const changeNotice = [
          `**${publicModelLabel}** also made code changes:`,
          "",
          `Branch: \`${workBranch}\``,
          `[View changes](https://github.com/${context.repo.fullName}/compare/${baseBranch}...${workBranch})`,
        ].join("\n");

        try {
          await postComment(octokit, context, changeNotice, modelLabel);
        } catch (err) {
          console.warn("Could not post change notice:", err);
        }
      }
    } catch (err) {
      console.warn("Git operations failed:", err);
    }
  }

  // Post PR review if no tracking comment
  if (context.isPR && !commentId) {
    try {
      const reviewOutput = inputs.showCost
        ? `${truncate(publicOutput)}\n\n_${costLine}_`
        : truncate(publicOutput);
      await createPRReview(octokit, context, reviewOutput, publicConclusion, activeModelLabel);
      reviewDelivered = true;
    } catch (err) {
      console.warn("Could not create PR review:", err);
    }
  }

  // Post regular comment for issues without tracking
  if (!context.isPR && !commentId) {
    try {
      await postComment(
        octokit,
        context,
        [
          publicConclusion === "success"
            ? spinnerHeader(activeModelLabel, "analysis complete")
            : spinnerHeader(activeModelLabel, "encountered an issue"),
          "",
          truncate(publicOutput),
          ...(inputs.showCost ? ["", `_${costLine}_`] : []),
          "",
          `[View run](${jobRunLink})`,
        ].join("\n"),
        activeModelLabel,
      );
      reviewDelivered = true;
    } catch (err) {
      console.warn("Could not post comment:", err);
    }
  }

  // ── Phase 5b: Post structured inline findings when available ─────────
  let inlineSummary: PostSummary = { posted: 0, skipped: 0, failed: 0 };
  const inlineFallbackBuffer =
    context.isPR && inlineSummary.posted === 0 && (inlineSummary.duplicate ?? 0) === 0
      ? inlineReviewBufferFromFindings(parsedFindings)
      : "";
  if (context.isPR && inlineFallbackBuffer.trim()) {
    try {
      const summary = await postBuffered({
        readBuffer: () => inlineFallbackBuffer,
        // Host-side delivery for models that returned structured findings.
        octokit: octokit.rest,
        env: {
          repoOwner: context.repo.owner,
          repoName: context.repo.repo,
          prNumber: String(context.entityNumber),
        },
        log: (m) => console.log(`[post-findings] ${m}`),
      });
      inlineSummary = mergePostSummaries(inlineSummary, summary);
      console.log(
        `[post-findings] posted=${summary.posted} skipped=${summary.skipped} failed=${summary.failed}`,
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
        trackingModelLabel,
      );
    } catch (err) {
      console.warn("Could not update tracking comment with inline lifecycle note:", err);
    }
  }

  // ── Phase 6: Set outputs ─────────────────────────────────────────────
  const finalConclusion = reviewConclusion(result.conclusion, publicReview.usable, reviewDelivered);
  core.setOutput("conclusion", finalConclusion);
  core.setOutput("branch_name", workBranch || "");
  core.setOutput("comment_id", commentId ? String(commentId) : "");
  core.setOutput("session_id", result.sessionId || "");
  core.setOutput("summary", publicOutput.substring(0, 1000));
  core.setOutput("cost_usd", costTotal.costUsd.toFixed(6));
  core.setOutput("input_tokens", String(costTotal.inputTokens));
  core.setOutput("output_tokens", String(costTotal.outputTokens));

  const reviewSummary = buildReviewSummary({
    context,
    runId,
    jobRunLink,
    conclusion: finalConclusion,
    mode: resolvedMode.mode,
    requestedStrategy: inputs.reviewStrategy,
    executedStrategy: useReviewPlan ? reviewPlan.strategy : "solo",
    primaryModelLabel: modelLabel,
    finalModelLabel: activeModelLabel,
    startedAt: actionStartedAt,
    finishedAt: new Date(),
    commentId,
    branchName: workBranch,
    inlineComments: inlineSummary,
    costTotal,
    runs: runMetrics,
    findings: parsedFindings,
  });
  const reviewSummaryJson = JSON.stringify(reviewSummary);
  const reviewSummaryFileJson = JSON.stringify(reviewSummary, null, 2);
  const reviewSummaryPath = join(tmpDir, "elek-review-summary.json");
  try {
    writeFileSync(reviewSummaryPath, `${reviewSummaryFileJson}\n`, "utf-8");
    core.setOutput("review_summary_path", reviewSummaryPath);
    console.log(`Wrote review summary: ${reviewSummaryPath}`);
  } catch (err) {
    console.warn("Could not write review summary:", (err as Error).message);
    core.setOutput("review_summary_path", "");
  }
  core.setOutput("review_summary_json", reviewSummaryJson);

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

function parseExistingTrackingCommentId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function mergePostSummaries(a: PostSummary, b: PostSummary): PostSummary {
  const duplicate = (a.duplicate ?? 0) + (b.duplicate ?? 0);
  return {
    posted: a.posted + b.posted,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
    ...(duplicate > 0 ? { duplicate } : {}),
  };
}
