/**
 * Tests for buildPrompt — XML-tagged structured prompt for pi.
 * Pure formatting; no GitHub or git calls.
 */
import { describe, it, expect } from "bun:test";
import { buildPrompt, type GitHubData } from "../src/github/data";

const baseData: GitHubData = {
  type: "pr",
  title: "Add login flow",
  body: "Implements basic auth",
  author: "alice",
  comments: [],
  reviewComments: [],
  labels: ["enhancement"],
  assignees: [],
  entityNumber: 17,
  pr: { headRef: "feat/auth", baseRef: "main" },
  diff: "@@ -1,2 +1,3 @@\n+console.log('hi')",
};

describe("buildPrompt", () => {
  it("includes the structured context block with title, author, branch", () => {
    const out = buildPrompt(baseData, "review pls", "deepseek/v4", "https://job/1");
    expect(out).toContain("<context>");
    expect(out).toContain("PR Title: Add login flow");
    expect(out).toContain("Author: alice");
    expect(out).toContain("Branch: feat/auth → main");
    expect(out).toContain("</context>");
  });

  it("wraps the diff in a fenced diff block inside <changed_files>", () => {
    const out = buildPrompt(baseData, "", "m", "j");
    expect(out).toContain("<changed_files>");
    expect(out).toContain("```diff");
    expect(out).toContain("+console.log('hi')");
    expect(out).toContain("</changed_files>");
  });

  it("truncates a giant diff with a (... N more lines) marker", () => {
    const big = Array.from({ length: 600 }, (_, i) => `+ line ${i}`).join("\n");
    const out = buildPrompt({ ...baseData, diff: big }, "", "m", "j");
    expect(out).toContain("... (");
    expect(out).toContain("more lines)");
  });

  it("includes user_request and metadata blocks", () => {
    const out = buildPrompt(baseData, "find bugs", "deepseek/v4", "https://j", 555);
    expect(out).toContain("<user_request>");
    expect(out).toContain("find bugs");
    expect(out).toContain("</user_request>");
    expect(out).toContain("<metadata>");
    expect(out).toContain("comment_id: 555");
    expect(out).toContain("model: deepseek/v4");
  });

  it("falls back to default review prompt when userRequest is empty", () => {
    const out = buildPrompt(baseData, "", "m", "j");
    expect(out).toContain("Please review this pull request");
  });

  it("uses issue_body tag and omits diff for issue context", () => {
    const issueData: GitHubData = {
      type: "issue",
      title: "Crash on login",
      body: "Steps: ...",
      author: "alice",
      comments: [],
      reviewComments: [],
      labels: [],
      assignees: [],
      entityNumber: 42,
    };
    const out = buildPrompt(issueData, "", "m", "j");
    expect(out).toContain("<issue_body>");
    expect(out).toContain("Steps: ...");
    expect(out).not.toContain("<changed_files>");
    expect(out).toContain("Please review this issue");
  });

  it("includes review comments only when present", () => {
    const out = buildPrompt(
      { ...baseData, reviewComments: ["[src/a.ts:10]: nit: rename foo"] },
      "",
      "m",
      "j",
    );
    expect(out).toContain("<review_comments>");
    expect(out).toContain("nit: rename foo");

    const out2 = buildPrompt(baseData, "", "m", "j");
    expect(out2).not.toContain("<review_comments>");
  });

  it("renders 'no description' when body is empty", () => {
    const out = buildPrompt({ ...baseData, body: "" }, "", "m", "j");
    expect(out).toContain("(no description)");
  });

  it("injects MCP tool guidance only when useMcp is true", () => {
    const withMcp = buildPrompt(baseData, "", "m", "j", undefined, { useMcp: true });
    expect(withMcp).toContain("create_inline_comment");
    expect(withMcp).toContain("update_tracking_comment");
    expect(withMcp).toContain("```suggestion");

    const noMcp = buildPrompt(baseData, "", "m", "j");
    expect(noMcp).not.toContain("create_inline_comment");
    expect(noMcp).not.toContain("update_tracking_comment");
  });

  it("does not tell review-only models to run commands or make edits", () => {
    const out = buildPrompt(baseData, "", "m", "j", undefined, {
      useMcp: true,
      allowEdit: false,
      tools: "read,grep,find,ls,mcp",
    });

    expect(out).toContain("Use the read, grep, find, and ls tools");
    expect(out).toContain("Do not claim tests passed unless");
    expect(out).not.toContain("Run relevant tests");
    expect(out).not.toContain("Make changes using");
    expect(out).not.toContain("git add");
  });

  it("tells review+edit models that elek handles git commands", () => {
    const out = buildPrompt(baseData, "", "m", "j", undefined, {
      useMcp: true,
      allowEdit: true,
      tools: "read,write,edit,grep,find,ls,mcp",
    });

    expect(out).toContain("Make focused edits using write/edit tools");
    expect(out).toContain("elek will stage, commit, and push");
    expect(out).not.toContain("git add");
  });

  it("keeps shell workflow guidance for legacy agent mode", () => {
    const out = buildPrompt(baseData, "", "m", "j", undefined, {
      useMcp: false,
      allowEdit: true,
      tools: "read,write,edit,bash,grep,find,ls",
    });

    expect(out).toContain("Run relevant tests when the tool surface allows it");
    expect(out).toContain("Stage changes: `git add <files>`");
  });

  it("does not infer shell access from disabled MCP alone", () => {
    const out = buildPrompt(baseData, "", "m", "j", undefined, {
      useMcp: false,
      allowEdit: true,
      tools: "read,write,edit,grep,find,ls,mcp",
    });

    expect(out).toContain("Make focused edits using write/edit tools");
    expect(out).toContain("elek will stage, commit, and push");
    expect(out).not.toContain("git add");
    expect(out).not.toContain("Run relevant tests");
  });

  it("requires the review finding contract in the response format", () => {
    const out = buildPrompt(baseData, "", "m", "j");

    expect(out).toContain("### Review finding contract");
    expect(out).toContain("Every finding must include severity, confidence, evidence, impact, and a concrete fix.");
    expect(out).toContain("Prioritize by severity: 🔴 critical → 🟡 important → 🟢 minor");
    expect(out).toContain("- Severity: critical|important|minor");
    expect(out).toContain("- Confidence: high|medium");
    expect(out).toContain("- Evidence: quote or summarize the concrete code path");
    expect(out).toContain("- Fix: the smallest concrete change required");
    expect(out).toContain("Do not surface low-confidence findings.");
    expect(out).not.toContain("**Fix:**");
  });

  it("includes repo config policy when supplied", () => {
    const out = buildPrompt(baseData, "", "m", "j", undefined, {
      repoConfig: {
        severityThreshold: "important",
        ignorePaths: ["docs/**"],
        instructions: ["Treat auth changes as security-sensitive."],
      },
    });

    expect(out).toContain("<elek_config>");
    expect(out).toContain("severity_threshold: important");
    expect(out).toContain("ignore_paths:");
    expect(out).toContain("- docs/**");
    expect(out).toContain("- Treat auth changes as security-sensitive.");
    expect(out).toContain("</elek_config>");
  });
});
