/**
 * Tests for the review-only MCP server handlers.
 * Handlers take injected deps (octokit, buffer writer, env) so tests
 * never touch real I/O or the MCP SDK.
 */
import { describe, it, expect } from "bun:test";
import {
  buildReviewCommentParams,
  createInlineComment,
  sanitize,
  updateTrackingComment,
  type Deps,
} from "../src/mcp/handlers";

/** Build a Deps double that records every octokit call and buffer write. */
function makeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps;
  calls: { method: string; args: unknown }[];
  buffer: string[];
} {
  const calls: { method: string; args: unknown }[] = [];
  const buffer: string[] = [];
  const deps: Deps = {
    octokit: {
      pulls: {
        createReviewComment: async (args: unknown) => {
          calls.push({ method: "pulls.createReviewComment", args });
          return { data: { id: 1, html_url: "u", path: "p", line: 1 } };
        },
        get: async (args: unknown) => {
          calls.push({ method: "pulls.get", args });
          return { data: { head: { sha: "deadbeef" } } };
        },
      },
      issues: {
        updateComment: async (args: unknown) => {
          calls.push({ method: "issues.updateComment", args });
          return { data: { id: 1, html_url: "u" } };
        },
      },
    },
    appendBuffer: (line) => buffer.push(line),
    env: {
      repoOwner: "octo",
      repoName: "repo",
      prNumber: "42",
    },
    now: () => new Date("2026-05-03T12:00:00Z"),
    ...overrides,
  };
  return { deps, calls, buffer };
}

describe("updateTrackingComment", () => {
  it("ignores arg-level comment_id and only updates the env-pinned one", async () => {
    const { deps, calls } = makeDeps({
      env: {
        repoOwner: "octo",
        repoName: "repo",
        prNumber: "42",
        trackingCommentId: "555",
      },
    });

    // Simulate the wire format: a model sends a request that tries to override
    // which comment is updated. The type system rejects this on the TS side,
    // but MCP receives JSON, so we cast to unknown here and assert at runtime.
    await updateTrackingComment(deps, {
      body: "## Review Summary\nNo high-confidence findings.",
      // @ts-expect-error — testing that extra fields are ignored
      comment_id: 999,
    } as unknown as { body: string });

    const update = calls.find((c) => c.method === "issues.updateComment");
    const params = update!.args as Record<string, unknown>;
    expect(params.comment_id).toBe(555);
    expect(params.comment_id).not.toBe(999);
  });

  it("rejects when trackingCommentId is not in env", async () => {
    const { deps, calls } = makeDeps(); // no trackingCommentId

    const result = await updateTrackingComment(deps, { body: "anything" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/trackingCommentId/);
    expect(calls.length).toBe(0);
  });

  it("updates the comment_id pinned in env (not anything supplied via args)", async () => {
    const { deps, calls } = makeDeps({
      env: {
        repoOwner: "octo",
        repoName: "repo",
        prNumber: "42",
        trackingCommentId: "555",
      },
    });

    const result = await updateTrackingComment(deps, {
      body: "## Review Summary\nNo high-confidence findings.",
    });

    expect(result.ok).toBe(true);
    const update = calls.find((c) => c.method === "issues.updateComment");
    expect(update).toBeDefined();
    const params = update!.args as Record<string, unknown>;
    expect(params).toMatchObject({
      owner: "octo",
      repo: "repo",
      comment_id: 555,
      body: "## Review Summary\nNo high-confidence findings.",
    });
  });

  it("rejects public tracking updates that contain internal delivery failures", async () => {
    const { deps, calls } = makeDeps({
      env: {
        repoOwner: "octo",
        repoName: "repo",
        prNumber: "42",
        trackingCommentId: "555",
      },
    });

    const result = await updateTrackingComment(deps, {
      body: "The elek_review_create_inline_comment tool failed with args: must be string, so I cannot post comments.",
    });

    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("rejects tracking updates with internal analysis narration from the shared guard", async () => {
    const { deps, calls } = makeDeps({
      env: {
        repoOwner: "octo",
        repoName: "repo",
        prNumber: "42",
        trackingCommentId: "555",
      },
    });

    const result = await updateTrackingComment(deps, {
      body: "## Analysis\nI need to inspect files before I decide how to post the review.",
    });

    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("rejects tracking updates that are not structured review feedback", async () => {
    const { deps, calls } = makeDeps({
      env: {
        repoOwner: "octo",
        repoName: "repo",
        prNumber: "42",
        trackingCommentId: "555",
      },
    });

    const result = await updateTrackingComment(deps, {
      body: "LGTM, safe to merge.",
    });

    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe("sanitize", () => {
  it("redacts every classic GitHub token prefix (ghp/ghs/gho/ghu/ghr)", () => {
    const tokens = ["ghp_", "ghs_", "gho_", "ghu_", "ghr_"]
      .map((p) => `leak: ${p}AbCd1234567890123456EfGh`);
    for (const sample of tokens) {
      const out = sanitize(sample);
      expect(out).not.toContain("AbCd1234");
      expect(out).toContain("[REDACTED]");
    }
  });

  it("redacts fine-grained github_pat_ tokens with underscores", () => {
    const sample =
      "token: github_pat_11AAAAAAAA0aaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const out = sanitize(sample);
    expect(out).not.toContain("github_pat_");
    expect(out).toContain("[REDACTED]");
  });

  it("leaves normal text untouched (no false positives)", () => {
    const text = "fix typo in README, see PR #42 for context";
    expect(sanitize(text)).toBe(text);
  });

  it("redacts a token embedded in a longer comment, preserving surrounding text", () => {
    const out = sanitize("Bug: token ghp_AbCd1234567890123456 found in logs");
    expect(out).toContain("Bug:");
    expect(out).toContain("found in logs");
    expect(out).not.toContain("ghp_AbCd");
  });

  it("redacts provider API keys (sk-) and JWTs and AWS keys", () => {
    const samples = [
      "key: sk-abcdef0123456789ABCDEF",
      "bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "aws AKIAIOSFODNN7EXAMPLE found",
    ];
    for (const sample of samples) {
      const out = sanitize(sample);
      expect(out).toContain("[REDACTED]");
      expect(out).not.toContain("sk-abcdef0123456789ABCDEF");
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    }
  });

  it("redacts Google API keys in public model output", () => {
    const key = `AIza${"A".repeat(35)}`;
    const out = sanitize(`provider key: ${key}`);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(key);
  });

  it("leaves commit SHAs and code blocks intact (no false positives)", () => {
    const sha = "3e6d2c1a0b9f4e8d7c6b5a49382716f0a1b2c3d4"; // 40 hex git SHA
    const text = `Last good commit: ${sha}\n\n\`\`\`\nconst x = 1;\n\`\`\``;
    expect(sanitize(text)).toBe(text);
  });
});

describe("buildReviewCommentParams", () => {
  const env = { repoOwner: "octo", repoName: "repo", prNumber: "1" };

  it("does not include `line` in the params when it's undefined", () => {
    // Defends against a stray entry slipping past validation that has neither
    // line nor startLine — GitHub rejects { line: undefined } noisily.
    const params = buildReviewCommentParams({ path: "p", body: "b" }, env, "sha");
    expect("line" in params).toBe(false);
  });

  it("includes single-line `line` and omits start_line/start_side", () => {
    const params = buildReviewCommentParams(
      { path: "p", body: "b", line: 10 },
      env,
      "sha",
    );
    expect(params.line).toBe(10);
    expect("start_line" in params).toBe(false);
    expect("start_side" in params).toBe(false);
  });

  it("includes start_line + start_side for multi-line", () => {
    const params = buildReviewCommentParams(
      { path: "p", body: "b", startLine: 5, line: 10, side: "LEFT" },
      env,
      "sha",
    );
    expect(params.start_line).toBe(5);
    expect(params.start_side).toBe("LEFT");
    expect(params.line).toBe(10);
  });
});

describe("createInlineComment", () => {
  it("buffers the call (and does NOT hit octokit) when confirmed is not true", async () => {
    const { deps, calls, buffer } = makeDeps();

    const result = await createInlineComment(deps, {
      path: "src/x.ts",
      body: "nit: rename",
      line: 10,
    });

    expect(result.ok).toBe(true);
    expect(buffer.length).toBe(1);
    expect(calls.length).toBe(0);
  });

  it("buffers a single-line review comment when confirmed=true", async () => {
    const { deps, calls, buffer } = makeDeps();

    const result = await createInlineComment(deps, {
      path: "src/x.ts",
      body: "nit: rename foo to bar",
      line: 10,
      confirmed: true,
    });

    expect(result.ok).toBe(true);
    expect(buffer.length).toBe(1);
    expect(calls.length).toBe(0);
    expect(JSON.parse(buffer[0])).toMatchObject({
      path: "src/x.ts",
      line: 10,
      body: "nit: rename foo to bar",
      confirmed: true,
    });
  });

  it("buffers a multi-line review comment when startLine and line are both set", async () => {
    const { deps, calls, buffer } = makeDeps();

    await createInlineComment(deps, {
      path: "src/x.ts",
      body: "this whole block is dead code",
      startLine: 15,
      line: 22,
      side: "LEFT",
      confirmed: true,
    });

    expect(calls.length).toBe(0);
    expect(JSON.parse(buffer[0])).toMatchObject({
      path: "src/x.ts",
      startLine: 15,
      line: 22,
      side: "LEFT",
      confirmed: true,
    });
  });

  it("preserves commit_id without making a live GitHub API call", async () => {
    const { deps, calls, buffer } = makeDeps();

    await createInlineComment(deps, {
      path: "src/x.ts",
      body: "comment",
      line: 5,
      commit_id: "cafef00d",
      confirmed: true,
    });

    expect(calls.length).toBe(0);
    expect(JSON.parse(buffer[0]).commit_id).toBe("cafef00d");
  });

  it("strips GitHub token-shaped strings from the body before buffering", async () => {
    const { deps, buffer } = makeDeps();

    await createInlineComment(deps, {
      path: "src/x.ts",
      body: "leaked: ghp_AbCd1234EfGh5678IjKl9012MnOp3456QrSt",
      line: 1,
    });

    expect(buffer.length).toBe(1);
    const entry = JSON.parse(buffer[0]);
    expect(entry.body).not.toContain("ghp_AbCd");
    expect(entry.body).toContain("[REDACTED]");
  });

  it("rejects inline comments that contain internal delivery narration", async () => {
    const { deps, calls, buffer } = makeDeps();

    const result = await createInlineComment(deps, {
      path: "src/x.ts",
      body: "The elek_review_create_inline_comment tool failed with args: must be string.",
      line: 10,
    });

    expect(result.ok).toBe(false);
    expect(buffer.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("strips GitHub token-shaped strings before buffering confirmed findings", async () => {
    const { deps, calls, buffer } = makeDeps();

    await createInlineComment(deps, {
      path: "src/x.ts",
      body: "secret: github_pat_11AAAAAAAA0aaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      line: 1,
      confirmed: true,
    });

    expect(calls.length).toBe(0);
    const entry = JSON.parse(buffer[0]);
    expect(entry.body).not.toContain("github_pat_");
    expect(entry.body).toContain("[REDACTED]");
  });

  it("preserves the full set of fields when buffering", async () => {
    const { deps, buffer } = makeDeps();

    await createInlineComment(deps, {
      path: "src/x.ts",
      body: "extract this into a helper",
      line: 30,
      startLine: 25,
      side: "RIGHT",
      commit_id: "abc1234",
    });

    expect(buffer.length).toBe(1);
    const entry = JSON.parse(buffer[0]);
    expect(entry).toMatchObject({
      ts: "2026-05-03T12:00:00.000Z", // from injected `now`
      path: "src/x.ts",
      line: 30,
      startLine: 25,
      side: "RIGHT",
      commit_id: "abc1234",
      body: "extract this into a helper",
    });
  });

  it("preserves the confirmed flag in the buffered entry", async () => {
    // The post-step skips entries with confirmed:false. If the flag isn't
    // written here, that opt-out is dead in production.
    const { deps, buffer } = makeDeps();
    await createInlineComment(deps, {
      path: "p",
      body: "b",
      line: 1,
      confirmed: false,
    });
    expect(buffer.length).toBe(1);
    const entry = JSON.parse(buffer[0]);
    expect(entry.confirmed).toBe(false);
  });

  it("rejects when startLine is set but line is missing (multi-line needs both)", async () => {
    const { deps, calls, buffer } = makeDeps();
    const result = await createInlineComment(deps, {
      path: "src/x.ts",
      body: "y",
      startLine: 5,
      confirmed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain("multi-line");
    expect(buffer.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("rejects when neither line nor startLine is provided", async () => {
    const { deps, calls, buffer } = makeDeps();

    const result = await createInlineComment(deps, {
      path: "src/x.ts",
      body: "where?",
      confirmed: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/line/i);
    expect(buffer.length).toBe(0);
    expect(calls.length).toBe(0);
  });
});
