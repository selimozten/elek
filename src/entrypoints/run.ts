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
import { detectTrigger, isActorAllowed } from "../github/trigger.js";
import { fetchGitHubData, buildPrompt } from "../github/data.js";
import {
  configureGitAuth,
  createPiBranch,
  commitChanges,
  pushBranch,
} from "../github/git.js";
import {
  createTrackingComment,
  updateTrackingComment,
  createPRReview,
  postComment,
} from "../github/comments.js";
import { runPi } from "../pi.js";
import type { PiRunResult } from "../types.js";

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

  // Configure git for potential code changes
  configureGitAuth(githubToken, context);

  // Determine base branch
  const baseBranch =
    inputs.baseBranch || context.pr?.baseRef || context.repo.defaultBranch;

  // Create a pi branch for code changes (PRs only)
  let piBranch: string | undefined;
  if (context.isPR) {
    piBranch = createPiBranch(context, inputs.branchPrefix);
  }

  // Create tracking comment
  let commentId: number | undefined;
  if (inputs.stickyComment) {
    try {
      const comment = await createTrackingComment(octokit, context);
      commentId = comment.id;
    } catch (err) {
      console.warn("Could not create tracking comment:", err);
    }
  }

  // ── Phase 3: Fetch data & build prompt ───────────────────────────────
  const data = await fetchGitHubData(context);
  const prompt = buildPrompt(data, userRequest);

  // Write prompt to file for debugging
  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const promptDir = join(tmpDir, "pi-prompts");
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(join(promptDir, "prompt.md"), prompt, "utf-8");

  // ── Phase 4: Run pi ──────────────────────────────────────────────────
  console.log("── Running pi ──");

  if (commentId) {
    await updateTrackingComment(
      octokit,
      context,
      commentId,
      "🤖 **pi is analyzing...**\n\nAnalyzing changes, this may take a minute...",
    );
  }

  const result: PiRunResult = runPi(prompt, inputs);

  console.log(`── pi ${result.conclusion === "success" ? "completed" : "failed"} ──`);
  if (result.output) {
    console.log(result.output.substring(0, 500) + (result.output.length > 500 ? "..." : ""));
  }

  // ── Phase 5: Handle results ──────────────────────────────────────────
  const modelLabel = inputs.model
    ? `**${inputs.provider}/${inputs.model}**`
    : `**${inputs.provider}**`;

  // Always post the review comment first (before git ops, which can fail)
  if (commentId) {
    const reviewBody = [
      result.conclusion === "success"
        ? `🤖 ${modelLabel} **analysis complete**`
        : `⚠️ ${modelLabel} **encountered an issue**`,
      "",
      result.output.substring(0, 4000),
    ].join("\n");

    try {
      await updateTrackingComment(octokit, context, commentId, reviewBody);
    } catch (err) {
      console.warn("Could not update tracking comment, posting new one:", err);
      try {
        await postComment(octokit, context, reviewBody);
      } catch (err2) {
        console.warn("Could not post comment either:", err2);
      }
    }
  }

  // Then handle any code changes pi made (separate from the review comment)
  if (result.conclusion === "success" && piBranch) {
    try {
      // Only count non-lockfile changes as pi's work
      // Filter in JS instead of grep -v to avoid exit code 1 when no matches
      const status = execSync("git status --porcelain", {
        encoding: "utf-8",
        stdio: "pipe",
      });

      const relevantChanges = status
        .split("\n")
        .filter((line) => line && !line.includes("package-lock.json") && !line.includes("node_modules"))
        .join("\n");

      if (relevantChanges.trim()) {
        commitChanges(`pi: automated changes for #${context.entityNumber}`);
        pushBranch(piBranch);

        const changeNotice = [
          `🔨 ${modelLabel} also made code changes:`,
          "",
          `Branch: \`${piBranch}\``,
          `[View changes](https://github.com/${context.repo.fullName}/compare/${baseBranch}...${piBranch})`,
        ].join("\n");

        try {
          await postComment(octokit, context, changeNotice);
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
      await createPRReview(octokit, context, result.output, result.conclusion);
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
          result.conclusion === "success" ? "🤖" : "⚠️",
          ` ${modelLabel}`,
          "",
          result.output.substring(0, 4000),
        ].join("\n"),
      );
    } catch (err) {
      console.warn("Could not post comment:", err);
    }
  }

  // ── Phase 6: Set outputs ─────────────────────────────────────────────
  core.setOutput("conclusion", result.conclusion);
  core.setOutput("branch_name", piBranch || "");
  core.setOutput("comment_id", commentId ? String(commentId) : "");
  core.setOutput("session_id", result.sessionId || "");
  core.setOutput("summary", result.output.substring(0, 1000));

  if (result.conclusion === "failure") {
    core.setFailed("pi execution failed");
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  core.setFailed(`Fatal: ${err.message}`);
  process.exit(1);
});
