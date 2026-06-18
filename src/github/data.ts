/**
 * GitHub data fetching and prompt building.
 */
import type { GitHubEntityContext } from "../types.js";
import { getGitDiff } from "./git.js";
import { mcpToolGuidance } from "./mcp-guidance.js";
import { findingValidationBullets, reviewContractBullets, reviewFindingTemplate } from "../review/contract.js";
import { formatConfigPromptBlock, type ElekConfig } from "../config.js";
import { formatChangedFilesForPrompt } from "../review/diff-context.js";

const CHANGED_FILES_PROMPT_CHARS = 200_000;

type MinimalOctokit = {
  rest: {
    issues: {
      listComments: (params: any) => Promise<any>;
    };
  };
};

export interface GitHubData {
  type: "pr" | "issue";
  title: string;
  body: string;
  author: string;
  diff?: string;
  comments: string[];
  reviewComments: string[];
  labels: string[];
  assignees: string[];
  entityNumber: number;
  /** PR-specific */
  pr?: {
    headRef: string;
    baseRef: string;
  };
}

/**
 * Fetch all relevant data for a PR or issue context.
 */
export async function fetchGitHubData(
  context: GitHubEntityContext,
  octokit?: MinimalOctokit,
): Promise<GitHubData> {
  const base: GitHubData = {
    type: context.isPR ? "pr" : "issue",
    title: context.pr?.title || context.issue?.title || "",
    body: context.pr?.body || context.issue?.body || "",
    author: context.actor,
    comments: [],
    reviewComments: [],
    labels: context.issue?.labels || [],
    assignees: context.issue?.assignees || [],
    entityNumber: context.entityNumber,
  };

  if (context.isPR && context.pr) {
    base.pr = {
      headRef: context.pr.headRef,
      baseRef: context.pr.baseRef,
    };
    try {
      base.diff = getGitDiff(context.pr.baseRef, context.pr.headRef);
    } catch (err) {
      console.warn("Could not fetch PR diff:", err);
    }
  }

  // Fetch recent comments via GitHub API for additional context
  if (octokit) {
    try {
      const { data: comments } = await octokit.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.entityNumber,
        per_page: 20,
        sort: "created",
        direction: "desc",
      });

      // Include EVERY comment, including our own prior bot reviews — the
      // model needs to see its previous findings so it can iterate on them
      // (acknowledge what's been addressed, flag what's still outstanding).
      // Feed full context so the model can reason about its own history
      // rather than us pre-processing it.
      base.comments = (comments as Array<{ body?: string; user?: { login?: string } }>)
        .filter((c) => !!c.body)
        .map((c) => `[${c.user?.login || "unknown"}]: ${c.body}`)
        .reverse();
    } catch (err) {
      console.warn("Could not fetch comments:", err);
    }
  }

  return base;
}

/**
 * Build a structured prompt for pi with clear sections and capability boundaries.
 *
 * Uses XML-style tags for sections, step-by-step workflow instructions,
 * and clear capability boundaries so the model produces consistent results.
 */
export function buildPrompt(
  data: GitHubData,
  userRequest: string,
  modelLabel: string,
  jobRunLink: string,
  commentId?: number,
  options: { useMcp?: boolean; allowEdit?: boolean; tools?: string; repoConfig?: ElekConfig } = {},
): string {
  const isPR = data.type === "pr";
  const entityLabel = isPR ? "pull request" : "issue";
  const baseBranch = data.pr?.baseRef || "main";
  const canEdit = options.allowEdit === true;
  const toolSet = new Set(
    (options.tools || "")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
  );
  const canRunShell = canEdit && toolSet.has("bash");

  const parts: string[] = [];

  // ── Header ──
  parts.push(`You are an AI assistant reviewing a GitHub ${entityLabel}. Analyze the context carefully and respond with a thorough, structured review.`);
  parts.push("");

  // ── Context (XML-tagged, structured) ──
  parts.push("<context>");
  parts.push(`${isPR ? "PR" : "Issue"} Title: ${data.title}`);
  parts.push(`Author: ${data.author}`);
  parts.push(`Type: ${entityLabel}`);
  if (data.labels.length > 0) parts.push(`Labels: ${data.labels.join(", ")}`);
  if (data.assignees.length > 0) parts.push(`Assignees: ${data.assignees.join(", ")}`);
  if (isPR && data.pr) {
    parts.push(`Branch: ${data.pr.headRef} → ${data.pr.baseRef}`);
  }
  parts.push("</context>");
  parts.push("");

  // ── Body ──
  parts.push(`<${isPR ? "pr" : "issue"}_body>`);
  parts.push(data.body || "(no description)");
  parts.push(`</${isPR ? "pr" : "issue"}_body>`);
  parts.push("");

  // ── Diff (PR only) ──
  if (data.diff) {
    parts.push("<changed_files>");
    parts.push("```diff");
    parts.push(formatChangedFilesForPrompt(data.diff, CHANGED_FILES_PROMPT_CHARS));
    parts.push("```");
    parts.push("</changed_files>");
    parts.push("");
  }

  // ── Comments ──
  if (data.comments.length > 0) {
    parts.push("<comments>");
    data.comments.forEach((c) => parts.push(`- ${c}`));
    parts.push("</comments>");
    parts.push("");
  }

  // ── Review comments (PR only) ──
  if (data.reviewComments.length > 0) {
    parts.push("<review_comments>");
    data.reviewComments.forEach((c) => parts.push(`- ${c}`));
    parts.push("</review_comments>");
    parts.push("");
  }

  // ── Metadata ──
  const repo = process.env.GITHUB_REPOSITORY || "";
  parts.push("<metadata>");
  parts.push(`repository: ${repo}`);
  parts.push(`${isPR ? "pr" : "issue"}_number: ${data.entityNumber}`);
  parts.push(`model: ${modelLabel}`);
  if (commentId) parts.push(`comment_id: ${commentId}`);
  parts.push("</metadata>");
  parts.push("");

  const configBlock = options.repoConfig ? formatConfigPromptBlock(options.repoConfig) : [];
  if (configBlock.length > 0) {
    parts.push("<elek_config>");
    parts.push(...configBlock);
    parts.push("</elek_config>");
    parts.push("");
  }

  // ── User Request ──
  parts.push("<user_request>");
  parts.push(userRequest || `Please review this ${entityLabel} and provide detailed feedback.`);
  parts.push("</user_request>");
  parts.push("");

  // ── MCP tool guidance (review/review+edit modes) ──
  if (options.useMcp) {
    parts.push("## Available tools (via the `mcp` proxy)");
    parts.push("");
    parts.push(...mcpToolGuidance());
    parts.push("");
  }

  // ── Workflow Instructions ──
  parts.push("## Instructions");
  parts.push("");
  parts.push("Follow these steps:");
  parts.push("");
  parts.push("1. **Analyze the context** — Read the body, diff, and any comments to understand what changed and why.");
  parts.push("   - Do not claim external packages, GitHub Actions, model IDs, or APIs do not exist unless you can verify it from current repo files, package-manager output, or workflow error logs.");
  if (isPR) {
    if (canRunShell) {
      parts.push(`   - The PR base branch is \`${baseBranch}\`. Use \`git diff origin/${baseBranch}...HEAD\` to see changes.`);
    } else {
      parts.push(`   - The PR base branch is \`${baseBranch}\`. Use the \`<changed_files>\` block plus read/search tools to inspect changes.`);
    }
    parts.push("   - **Iterate on prior Elek reviews.** If `<comments>` contains a previous Elek review (look for `<!-- elek-bot`), open with a status update for each prior finding — fixed, still present, or no longer relevant — before listing new findings. Don't repeat findings that were addressed.");
  }
  parts.push("");
  parts.push("2. **Review thoroughly** — Check for:");
  parts.push("   - **Correctness**: logic errors, edge cases, off-by-one, null/undefined handling");
  parts.push("   - **Security**: injection risks, missing validation, exposed secrets, auth bypasses");
  parts.push("   - **Performance**: N+1 queries, unnecessary allocations, blocking operations");
  parts.push("   - **Style**: consistency with codebase conventions, naming, structure");
  parts.push("   - **Tests**: missing test coverage for new code paths");
  parts.push("");
  if (canRunShell) {
    parts.push("3. **Use tools to gather context** — Read files referenced in the diff. Run relevant tests when the tool surface allows it.");
  } else {
    parts.push("3. **Use tools to gather context** — Use the read, grep, find, and ls tools to inspect files referenced in the diff. Do not claim tests passed unless the prompt, comments, or workflow logs provide that evidence.");
  }
  parts.push("");
  parts.push("4. **Provide your review** — Be specific:");
  parts.push("   - Reference exact file paths and line numbers");
  parts.push("   - Use code blocks for suggestions");
  parts.push("   - Prioritize by severity: 🔴 critical → 🟡 important → 🟢 minor");
  parts.push("   - Follow the review finding contract for every finding.");
  parts.push(`   ${commentId ? "ALL feedback goes into your comment. Your console output is NOT visible to anyone." : ""}`);
  parts.push("");

  parts.push("### Review finding contract");
  parts.push("");
  parts.push(...reviewContractBullets());
  parts.push("");
  parts.push("### Finding acceptance gates");
  parts.push("");
  parts.push(...findingValidationBullets());
  parts.push("");

  // ── If making changes ──
  parts.push(canEdit ? "### If implementing changes" : "### Editing boundary");
  parts.push("");
  if (!canEdit) {
    parts.push("- Do not modify files, run commands, stage, commit, or push. Leave review feedback only.");
  } else if (canRunShell) {
    parts.push("- Make changes using the provided tools.");
    parts.push("- Stage changes: `git add <files>`");
    parts.push(`- Commit with a descriptive message: \`git commit -m "descriptive message"\``);
    parts.push("- Push to the remote branch");
    parts.push("- Reference the original issue/PR in your commit message");
  } else {
    parts.push("- Make focused edits using write/edit tools only when the requested fix is mechanical and low-risk.");
    parts.push("- Do not run git commands or claim tests passed unless logs already show that evidence.");
    parts.push("- elek will stage, commit, and push any non-lockfile changes after the run.");
    parts.push("- Reference the original issue/PR in your review comment.");
  }
  parts.push("");

  // ── Output format ──
  parts.push("### Response format");
  parts.push("");
  parts.push("Structure your review as:");
  parts.push("");
  parts.push("```markdown");
  parts.push("## Review Summary");
  parts.push("(1-2 sentence overview)");
  parts.push("");
  parts.push("## Findings");
  parts.push("");
  parts.push(...reviewFindingTemplate());
  parts.push("");
  parts.push("## Recommendations");
  parts.push("(broader suggestions, architecture notes, etc.)");
  parts.push("```");
  parts.push("");

  // ── Footer ──
  parts.push("---");
  parts.push(`*${modelLabel} · [View run](${jobRunLink})*`);

  return parts.join("\n");
}
