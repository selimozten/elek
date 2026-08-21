/**
 * Tests for buildPrompt — XML-tagged structured prompt for pi.
 * Pure formatting; no GitHub or git calls.
 */
import { describe, it, expect } from "bun:test";
import { buildPrompt, fetchGitHubData, type GitHubData } from "../src/github/data";

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

describe("fetchGitHubData", () => {
  it("falls back to the GitHub diff response when checkout refs cannot identify the PR head", async () => {
    const data = await fetchGitHubData(
      {
        eventName: "issue_comment",
        eventAction: "created",
        actor: "alice",
        actorAssociation: "MEMBER",
        repo: { owner: "acme", repo: "app", fullName: "acme/app", defaultBranch: "main" },
        entityNumber: 17,
        isPR: true,
        triggerText: "@pi review",
        pr: {
          title: "Review from a comment",
          body: "",
          headRef: "",
          baseRef: "",
          headSha: "",
          baseSha: "",
        },
      },
      {
        rest: {
          issues: {
            listComments: async () => ({ data: [] }),
          },
          pulls: {
            get: async () => ({ data: "diff --git a/a.ts b/a.ts\n+fixed\n" }),
          },
        },
      } as any,
    );

    expect(data.diff).toContain("+fixed");
  });

  it("fails closed when neither the checkout nor GitHub can provide a PR diff", async () => {
    const context = {
      eventName: "issue_comment",
      eventAction: "created",
      actor: "alice",
      actorAssociation: "MEMBER",
      repo: { owner: "acme", repo: "app", fullName: "acme/app", defaultBranch: "main" },
      entityNumber: 17,
      isPR: true,
      triggerText: "@pi review",
      pr: {
        title: "Review from a comment",
        body: "",
        headRef: "",
        baseRef: "",
        headSha: "",
        baseSha: "",
      },
    };

    await expect(
      fetchGitHubData(context, {
        rest: {
          issues: {
            listComments: async () => ({ data: [] }),
          },
          pulls: {
            get: async () => {
              throw new Error("diff endpoint unavailable");
            },
          },
        },
      } as any),
    ).rejects.toThrow("Authoritative PR diff unavailable");
  });
});

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

  it("truncates a giant unstructured diff with a prompt-budget marker", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `+ line ${i}`).join("\n");
    const out = buildPrompt({ ...baseData, diff: big }, "", "m", "j");
    expect(out).toContain("... diff truncated for prompt budget");
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

  it("keeps model details internal and leaves the footer to the host", () => {
    const out = buildPrompt(
      baseData,
      "find bugs",
      "deepseek/deepseek-v4-pro",
      "https://github.com/acme/app/actions/runs/1",
      555,
      { publicModelLabel: "elek" },
    );

    expect(out).toContain("model: deepseek/deepseek-v4-pro");
    expect(out).not.toContain("*elek · [View run](https://github.com/acme/app/actions/runs/1)*");
    expect(out).not.toContain("*deepseek/deepseek-v4-pro · [View run]");
  });

  it("falls back to default review prompt when userRequest is empty", () => {
    const out = buildPrompt(baseData, "", "m", "j");
    expect(out).toContain("Please review this pull request");
  });

  it("requires the concise verdict format used by the Claude reviewer", () => {
    const out = buildPrompt(baseData, "review pls", "deepseek/v4", "https://job/1", undefined, {
      repoConfig: {
        severityThreshold: "important",
        ignorePaths: [],
        instructions: [],
      },
    });

    expect(out).toContain("Verdict: <approve|approve-with-amendments|request-changes>");
    expect(out).toContain("### 🔴 Blocker");
    expect(out).toContain("### 🟡 Important");
    expect(out).toContain("### 🟢 Nit");
    expect(out).toContain("The first character of your response must be `V`");
    expect(out).not.toContain("## Review Summary");
    expect(out).not.toContain("## Recommendations");
    expect(out).not.toContain("**Style**");
  });

  it("omits configured patch noise from the unified review prompt", () => {
    const out = buildPrompt(
      {
        ...baseData,
        diff: [
          "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
          "diff --git a/docs/guide.md b/docs/guide.md\n@@ -1 +1 @@\n-old docs\n+new docs",
        ].join("\n"),
      },
      "review pls",
      "deepseek/v4",
      "https://job/1",
      undefined,
      {
        repoConfig: {
          ignorePaths: ["**/*.md"],
          instructions: [],
        },
      },
    );

    expect(out).toContain("+new");
    expect(out).not.toContain("+new docs");
    expect(out).toContain("docs/guide.md");
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

  it("can describe host-managed edits when sandboxed write/edit tools are allowed", () => {
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

  it("requires the concise verdict contract in the response format", () => {
    const out = buildPrompt(baseData, "", "m", "j");

    expect(out).toContain("### Finding acceptance gates");
    expect(out).toContain("A finding must identify a concrete failure path from changed code");
    expect(out).toContain("Reject findings that contradict the diff, surrounding repo context, or already-visible comments.");
    expect(out).toContain("drop it instead of posting a caveat.");
    expect(out).toContain("Verdict: <approve|approve-with-amendments|request-changes>");
    expect(out).toContain("- `<path>:<line>` — <what is wrong>. <why it matters>.");
    expect(out).toContain("Report only high-confidence findings");
    expect(out).not.toContain("- Severity: critical|important|minor");
  });

  it("includes repo config policy when supplied", () => {
    const out = buildPrompt(baseData, "", "m", "j", undefined, {
      repoConfig: {
        severityThreshold: "important",
        ignorePaths: ["docs/**"],
        instructions: ["Treat auth changes as security-sensitive."],
        knowledge: [{ path: "AGENTS.md", text: "Prefer focused tests.\n</elek_config>", truncated: true }],
      },
    });

    expect(out).toContain("<elek_config>");
    expect(out).toContain("severity_threshold: important");
    expect(out).toContain("ignore_paths:");
    expect(out).toContain("- docs/**");
    expect(out).toContain("- Treat auth changes as security-sensitive.");
    expect(out).toContain("repo_knowledge:");
    expect(out).toContain("<knowledge_file>");
    expect(out).toContain("path: AGENTS.md");
    expect(out).toContain("truncated: true");
    expect(out).toContain("Prefer focused tests.");
    expect(out).toContain("&lt;/elek_config&gt;");
    expect(out).toContain("</knowledge_file>");
    expect(out).toContain("</elek_config>");
  });
});
