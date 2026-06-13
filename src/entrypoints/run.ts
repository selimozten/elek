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
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";

import { parseInputs, parseEntityContext } from "../github/context.js";
import { detectTrigger, isActorAllowed } from "../github/trigger.js";
import { fetchGitHubData, buildPrompt } from "../github/data.js";
import { resolveEffectivePiTools, resolveMode } from "../github/mode.js";
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
  buildLensPrompt,
  buildSynthesisPrompt,
  resolveReviewPlan,
  resolveReviewPlanSupport,
} from "../review/strategy.js";
import { sanitize } from "../mcp/handlers.js";

async function run(): Promise<void> {
  // ── Phase 0: Parse inputs & context ──────────────────────────────────
  const inputs = parseInputs();
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
  const userRequest = detectTrigger(context, inputs);

  if (!userRequest) {
    console.log("No trigger detected — exiting cleanly");
    core.setOutput("conclusion", "skipped");
    core.setOutput("summary", "No trigger detected");
    return;
  }

  if (!isActorAllowed(context, inputs)) {
    console.log(`Actor @${context.actor} not allowed — exiting`);
    core.setOutput("conclusion", "skipped");
    core.setOutput("summary", `Actor @${context.actor} not authorized`);
    return;
  }

  console.log(
    `Triggered: "${userRequest.substring(0, 120)}${userRequest.length > 120 ? "..." : ""}"`,
  );

  // ── Phase 2: Setup ───────────────────────────────────────────────────
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    core.setFailed("GITHUB_TOKEN not available");
    return;
  }

  const octokit = github.getOctokit(githubToken);
  const modelLabel = inputs.model
    ? `${inputs.provider}/${inputs.model}`
    : inputs.provider;
  const runId = process.env.GITHUB_RUN_ID || "?";
  const jobRunLink = `https://github.com/${context.repo.fullName}/actions/runs/${runId}`;

  // Resolve mode → tool allowlist + MCP wiring
  const resolvedMode = resolveMode(inputs.mode);
  // MCP is on by default for review/review+edit modes (off only for `agent`
  // legacy mode). The earlier CI hang was caused by pi keeping stdin open;
  // fixed via stdio:["ignore",…] in pi.ts. ELEK_DISABLE_MCP=1 escape hatch
  // remains for emergency rollback.
  const mcpEnabled = resolvedMode.useMcpServer && process.env.ELEK_DISABLE_MCP !== "1";
  const piTools = resolveEffectivePiTools(resolvedMode, inputs.tools, { mcpEnabled });
  console.log(
    `Mode: ${resolvedMode.mode} | tools: ${piTools} | mcp: ${mcpEnabled}`,
  );
  const piInputs = { ...inputs, tools: piTools };

  // Configure git for potential code changes
  configureGitAuth(githubToken, context);

  // Determine base branch
  const baseBranch =
    inputs.baseBranch || context.pr?.baseRef || context.repo.defaultBranch;

  // Create an elek work branch for code changes (PRs only)
  let workBranch: string | undefined;
  if (context.isPR) {
    workBranch = createElekBranch(context, inputs.branchPrefix);
  }

  // Create tracking comment (with spinner, Claude-style)
  let commentId: number | undefined;
  if (inputs.stickyComment) {
    try {
      const comment = await createTrackingComment(octokit, context, modelLabel);
      commentId = comment.id;
    } catch (err) {
      console.warn("Could not create tracking comment:", err);
    }
  }

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

  let prompt = buildPrompt(data, userRequest, modelLabel, jobRunLink, commentId, {
    useMcp: mcpEnabled,
    allowEdit: resolvedMode.allowEdit,
    tools: piTools,
  });

  // Write prompt to file
  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const promptDir = join(tmpDir, "pi-prompts");
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(join(promptDir, "prompt.md"), prompt, "utf-8");

  const bufferPath = join(tmpDir, "elek-inline-buffer.jsonl");

  // pi-mcp-adapter reads either ./.mcp.json or ~/.config/mcp/mcp.json.
  // We choose the home-config path so the file (which carries GITHUB_TOKEN
  // in its env block) NEVER lands in the workspace — workspace files can be
  // uploaded as artifacts, persisted between steps on self-hosted runners,
  // or even committed by an over-eager model. Cleaned up in a finally block
  // below regardless of whether pi succeeds.
  const mcpConfigPath = mcpEnabled && context.isPR
    ? join(homedir(), ".config", "mcp", "mcp.json")
    : null;

  const writeMcpConfig = () => {
    if (!mcpConfigPath) return;
    const actionPath = process.env.GITHUB_ACTION_PATH || process.cwd();
    const serverPath = join(actionPath, "src/mcp/github-review-server.ts");
    mkdirSync(join(homedir(), ".config", "mcp"), { recursive: true });
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            "elek-review": {
              command: "tsx",
              args: [serverPath],
              env: {
                REPO_OWNER: context.repo.owner,
                REPO_NAME: context.repo.repo,
                PR_NUMBER: String(context.entityNumber),
                GITHUB_TOKEN: githubToken,
                ELEK_TRACKING_COMMENT_ID: commentId ? String(commentId) : "",
                ELEK_BUFFER_PATH: bufferPath,
              },
              lifecycle: "eager",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`Wrote ${mcpConfigPath} for pi-mcp-adapter`);
  };

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
      // wroteReview reflects whether we actually got output text
      progress.wroteReview = textStreamed || true;
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

  const reviewPlan = resolveReviewPlan(inputs);
  const reviewPlanSupport = resolveReviewPlanSupport(reviewPlan.strategy, {
    isPR: context.isPR,
    mode: resolvedMode.mode,
  });
  if (reviewPlanSupport.warning) console.warn(reviewPlanSupport.warning);
  const useReviewPlan = reviewPlanSupport.enabled;

  let finalInputs = piInputs;
  if (useReviewPlan) {
    const lensTools = resolveMode("review").piTools
      .split(",")
      .filter((tool) => tool !== "mcp")
      .join(",");

    console.log(
      `Review strategy: ${reviewPlan.strategy} | lenses: ${reviewPlan.jobs
        .map((j) => `${j.lens.id}:${j.model.label}`)
        .join(", ")} | validator: ${reviewPlan.validator.label}`,
    );
    if (reviewPlan.reusedModels) {
      console.warn(
        `Review strategy has ${reviewPlan.jobs.length} lenses but fewer reviewer models; models will be reused across lenses.`,
      );
    }

    if (commentId) {
      try {
        await updateTrackingComment(
          octokit,
          context,
          commentId,
          [
            `🔎 **${modelLabel}** running ${reviewPlan.strategy} review`,
            "",
            ...reviewPlan.jobs.map((j) => `- ${j.lens.title}: \`${j.model.label}\``),
            "",
            `Final validation: \`${reviewPlan.validator.label}\``,
            `[View run](${jobRunLink})`,
          ].join("\n"),
          modelLabel,
        );
      } catch (err) {
        console.warn("Could not update strategy status:", err);
      }
    }

    const reports = await Promise.all(
      reviewPlan.jobs.map(async (job) => {
        const lensPrompt = buildLensPrompt({
          data,
          userRequest,
          lens: job.lens,
          modelLabel: job.model.label,
        });
        const lensInputs = {
          ...piInputs,
          provider: job.model.provider,
          model: job.model.model,
          tools: lensTools,
          mode: "review",
        };
        const lensResult = await runPi(
          lensPrompt,
          lensInputs,
          undefined,
          false,
          { promptName: `lens-${job.lens.id}` },
        );
        const lensOutput = sanitize(lensResult.output);
        console.log(
          `[${job.lens.id}] ${lensResult.conclusion} · ${lensOutput.substring(0, 180)}`,
        );
        return {
          lens: job.lens,
          modelLabel: job.model.label,
          output: lensOutput,
          conclusion: lensResult.conclusion,
        };
      }),
    );

    finalInputs = {
      ...piInputs,
      provider: reviewPlan.validator.provider,
      model: reviewPlan.validator.model,
      tools: piTools,
      mode: "review",
    };
    prompt = buildSynthesisPrompt({
      data,
      userRequest,
      modelLabel: reviewPlan.validator.label,
      jobRunLink,
      commentId,
      reports,
    });
    writeFileSync(join(promptDir, "prompt.md"), prompt, "utf-8");
  }

  let result: PiRunResult;
  try {
    writeMcpConfig();
    result = await runPi(prompt, finalInputs, onProgress, mcpEnabled, { promptName: "prompt" });
  } finally {
    // Drop the MCP config (carries GITHUB_TOKEN) the moment pi exits.
    if (mcpConfigPath) {
      try { unlinkSync(mcpConfigPath); } catch { /* already gone */ }
    }
  }

  console.log(`── pi ${result.conclusion === "success" ? "completed" : "failed"} ──`);
  const safeOutput = sanitize(result.output);
  if (result.output) {
    console.log(safeOutput.substring(0, 500) + (safeOutput.length > 500 ? "..." : ""));
  }

  // ── Phase 5: Handle results ──────────────────────────────────────────
  // GitHub's hard limit on issue/PR comments is 65,536 chars; leave
  // headroom for the wrapper (header, signature, links).
  const MAX_REVIEW_CHARS = 60_000;
  const truncate = (s: string) =>
    s.length > MAX_REVIEW_CHARS
      ? `${s.slice(0, MAX_REVIEW_CHARS)}\n\n_…review truncated, ${s.length - MAX_REVIEW_CHARS} chars omitted_`
      : s;

  // Always post the review comment first (before git ops, which can fail)
  if (commentId) {
    const reviewBody = [
      result.conclusion === "success"
        ? spinnerHeader(modelLabel, "analysis complete")
        : spinnerHeader(modelLabel, "encountered an issue"),
      "",
      truncate(safeOutput),
      "",
      `[View run](${jobRunLink})`,
    ].join("\n");

    try {
      await updateTrackingComment(octokit, context, commentId, reviewBody, modelLabel);
    } catch (err) {
      console.warn("Could not update tracking comment, posting new one:", err);
      try {
        await postComment(octokit, context, reviewBody, modelLabel);
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
          `🔨 **${modelLabel}** also made code changes:`,
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
      await createPRReview(octokit, context, safeOutput, result.conclusion);
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
          result.conclusion === "success"
            ? spinnerHeader(modelLabel, "analysis complete")
            : spinnerHeader(modelLabel, "encountered an issue"),
          "",
          truncate(safeOutput),
          "",
          `[View run](${jobRunLink})`,
        ].join("\n"),
        modelLabel,
      );
    } catch (err) {
      console.warn("Could not post comment:", err);
    }
  }

  // ── Phase 5b: Drain the inline-comment buffer (MCP-only) ─────────────
  if (mcpEnabled && context.isPR && existsSync(bufferPath)) {
    try {
      const summary = await postBuffered({
        readBuffer: () => readFileSync(bufferPath, "utf-8"),
        // @actions/github's octokit exposes the API under `.rest` —
        // structurally compatible with PostBufferedOctokit (no cast needed).
        octokit: octokit.rest,
        env: {
          repoOwner: context.repo.owner,
          repoName: context.repo.repo,
          prNumber: String(context.entityNumber),
        },
        log: (m) => console.log(`[post-buffered] ${m}`),
      });
      console.log(
        `[post-buffered] posted=${summary.posted} skipped=${summary.skipped} failed=${summary.failed}`,
      );
    } catch (err) {
      console.warn("post-buffered failed:", (err as Error).message);
    }
  }

  // ── Phase 6: Set outputs ─────────────────────────────────────────────
  core.setOutput("conclusion", result.conclusion);
  core.setOutput("branch_name", workBranch || "");
  core.setOutput("comment_id", commentId ? String(commentId) : "");
  core.setOutput("session_id", result.sessionId || "");
  core.setOutput("summary", safeOutput.substring(0, 1000));

  if (result.conclusion === "failure") {
    core.setFailed("pi execution failed");
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  core.setFailed(`Fatal: ${err.message}`);
  process.exit(1);
});
