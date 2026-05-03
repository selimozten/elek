/**
 * GitHub data fetching and prompt building.
 * Structured prompt format inspired by Claude Code Action's XML-tagged approach.
 */
import type { GitHubEntityContext } from "../types";
import { getGitDiff } from "./git";

interface MinimalOctokit {
  rest: {
    issues: {
      listComments(params: any): Promise<{ data: Array<{ body?: string; user?: { login: string }; created_at: string }> }>;
    };
  };
}

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
      // Same pattern as claude-code-action: feed full context, let the model
      // reason about its own history rather than us pre-processing it.
      base.comments = comments
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
 * Build a structured prompt for pi — same quality level as Claude Code Action.
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
  options: { useMcp?: boolean; allowEdit?: boolean } = {},
): string {
  const isPR = data.type === "pr";
  const entityLabel = isPR ? "pull request" : "issue";
  const baseBranch = data.pr?.baseRef || "main";

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
    const maxLines = 500;
    const diffLines = data.diff.split("\n");
    const truncated =
      diffLines.length > maxLines
        ? diffLines.slice(0, maxLines).join("\n") +
          `\n... (${diffLines.length - maxLines} more lines)`
        : data.diff;

    parts.push("<changed_files>");
    parts.push("```diff");
    parts.push(truncated);
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

  // ── User Request ──
  parts.push("<user_request>");
  parts.push(userRequest || `Please review this ${entityLabel} and provide detailed feedback.`);
  parts.push("</user_request>");
  parts.push("");

  // ── MCP tool guidance (review/review+edit modes) ──
  if (options.useMcp) {
    parts.push("## Available tools");
    parts.push("");
    parts.push("You have a single proxy tool `mcp` that gives you access to the elek review server. Two operations:");
    parts.push("");
    parts.push("- `mcp({tool: \"create_inline_comment\", args: {path, line, body}})`");
    parts.push("  Post a finding on a specific line of the diff. For multi-line ranges, add `startLine`.");
    parts.push("  Buffered by default — only sent at the end of the run. Set `confirmed: true` to post immediately.");
    parts.push("  Use markdown suggestion blocks for actionable fixes:");
    parts.push("    ```suggestion");
    parts.push("    new code here");
    parts.push("    ```");
    parts.push("");
    parts.push("- `mcp({tool: \"update_tracking_comment\", args: {body}})`");
    parts.push("  Replace the body of your tracking comment. Use this to maintain a live todo checklist as you work.");
    parts.push("");
    parts.push("These are the ONLY ways your output is visible. Console output is discarded.");
    parts.push("");
  }

  // ── Workflow Instructions ──
  parts.push("## Instructions");
  parts.push("");
  parts.push("Follow these steps:");
  parts.push("");
  parts.push("1. **Analyze the context** — Read the body, diff, and any comments to understand what changed and why.");
  if (isPR) {
    parts.push(`   - The PR base branch is \`${baseBranch}\`. Use \`git diff origin/${baseBranch}...HEAD\` to see changes.`);
    parts.push(`   - **Iterate on your prior reviews.** If \`<comments>\` contains a previous review you wrote (look for \`<!-- elek-bot:${modelLabel} -->\`), open with a status update for each prior finding — fixed, still present, or no longer relevant — *before* listing new findings. Don't repeat findings that were addressed.`);
  }
  parts.push("");
  parts.push("2. **Review thoroughly** — Check for:");
  parts.push("   - **Correctness**: logic errors, edge cases, off-by-one, null/undefined handling");
  parts.push("   - **Security**: injection risks, missing validation, exposed secrets, auth bypasses");
  parts.push("   - **Performance**: N+1 queries, unnecessary allocations, blocking operations");
  parts.push("   - **Style**: consistency with codebase conventions, naming, structure");
  parts.push("   - **Tests**: missing test coverage for new code paths");
  parts.push("");
  parts.push("3. **Use tools to gather context** — Read files referenced in the diff. Run relevant tests if configured.");
  parts.push("");
  parts.push("4. **Provide your review** — Be specific:");
  parts.push("   - Reference exact file paths and line numbers");
  parts.push("   - Use code blocks for suggestions");
  parts.push("   - Prioritize by severity: 🔴 critical → 🟡 medium → 🟢 minor");
  parts.push(`   ${commentId ? "ALL feedback goes into your comment. Your console output is NOT visible to anyone." : ""}`);
  parts.push("");

  // ── If making changes ──
  parts.push("### If implementing changes");
  parts.push("");
  parts.push("- Make changes using the provided tools (read, write, edit, bash)");
  parts.push("- Stage changes: `git add <files>`");
  parts.push(`- Commit with a descriptive message: \`git commit -m "descriptive message"\``);
  parts.push("- Push to the remote branch");
  parts.push("- Reference the original issue/PR in your commit message");
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
  parts.push("### 🔴 Critical / 🟡 Medium / 🟢 Minor: [Title]");
  parts.push("**File:** `path/to/file.ts` (line N)");
  parts.push("");
  parts.push("Explanation of the issue and why it matters.");
  parts.push("");
  parts.push("**Fix:**");
  parts.push("```suggestion");
  parts.push("// code suggestion here");
  parts.push("```");
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

