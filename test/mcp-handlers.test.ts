/**
 * Tests for the review-only MCP server handlers.
 * Handlers take injected deps (octokit, buffer writer, env) so tests
 * never touch real I/O or the MCP SDK.
 */
import { describe, it, expect } from "bun:test";
import {
  createInlineComment,
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
      githubToken: "ghs_test",
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
        githubToken: "t",
        trackingCommentId: "555",
      },
    });

    // Simulate the wire format: a model sends a request that tries to override
    // which comment is updated. The type system rejects this on the TS side,
    // but MCP receives JSON, so we cast to unknown here and assert at runtime.
    await updateTrackingComment(deps, {
      body: "smuggled",
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
        githubToken: "t",
        trackingCommentId: "555",
      },
    });

    const result = await updateTrackingComment(deps, { body: "## working on it\n- [x] read" });

    expect(result.ok).toBe(true);
    const update = calls.find((c) => c.method === "issues.updateComment");
    expect(update).toBeDefined();
    const params = update!.args as Record<string, unknown>;
    expect(params).toMatchObject({
      owner: "octo",
      repo: "repo",
      comment_id: 555,
      body: "## working on it\n- [x] read",
    });
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

  it("posts a single-line review comment when confirmed=true", async () => {
    const { deps, calls, buffer } = makeDeps();

    const result = await createInlineComment(deps, {
      path: "src/x.ts",
      body: "nit: rename foo to bar",
      line: 10,
      confirmed: true,
    });

    expect(result.ok).toBe(true);
    expect(buffer.length).toBe(0);

    const post = calls.find((c) => c.method === "pulls.createReviewComment");
    expect(post).toBeDefined();
    const params = post!.args as Record<string, unknown>;
    expect(params).toMatchObject({
      owner: "octo",
      repo: "repo",
      pull_number: 42,
      path: "src/x.ts",
      body: "nit: rename foo to bar",
      line: 10,
      side: "RIGHT",
      commit_id: "deadbeef", // pulled from PR head
    });
    // single-line — start_line / start_side must NOT be present
    expect(params.start_line).toBeUndefined();
    expect(params.start_side).toBeUndefined();
  });

  it("posts a multi-line review comment when startLine and line are both set", async () => {
    const { deps, calls } = makeDeps();

    await createInlineComment(deps, {
      path: "src/x.ts",
      body: "this whole block is dead code",
      startLine: 15,
      line: 22,
      side: "LEFT",
      confirmed: true,
    });

    const post = calls.find((c) => c.method === "pulls.createReviewComment");
    expect(post).toBeDefined();
    const params = post!.args as Record<string, unknown>;
    expect(params).toMatchObject({
      path: "src/x.ts",
      start_line: 15,
      start_side: "LEFT",
      line: 22,
      side: "LEFT",
    });
  });

  it("uses an explicit commit_id over the PR head SHA", async () => {
    const { deps, calls } = makeDeps();

    await createInlineComment(deps, {
      path: "src/x.ts",
      body: "comment",
      line: 5,
      commit_id: "cafef00d",
      confirmed: true,
    });

    const post = calls.find((c) => c.method === "pulls.createReviewComment");
    const params = post!.args as Record<string, unknown>;
    expect(params.commit_id).toBe("cafef00d");
  });

  it("returns {ok:false} with the error message when octokit rejects", async () => {
    const { deps } = makeDeps({
      octokit: {
        pulls: {
          get: async () => ({ data: { head: { sha: "x" } } }),
          createReviewComment: async () => {
            throw new Error("Validation Failed: line 999 not in diff");
          },
        },
        issues: { updateComment: async () => ({ data: { id: 1, html_url: "u" } }) },
      },
    });

    const result = await createInlineComment(deps, {
      path: "src/x.ts",
      body: "b",
      line: 999,
      confirmed: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Validation Failed");
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

  it("strips GitHub token-shaped strings from the body before posting", async () => {
    const { deps, calls } = makeDeps();

    await createInlineComment(deps, {
      path: "src/x.ts",
      body: "secret: github_pat_11AAAAAAAA0aaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      line: 1,
      confirmed: true,
    });

    const post = calls.find((c) => c.method === "pulls.createReviewComment");
    const params = post!.args as Record<string, unknown>;
    expect(params.body).not.toContain("github_pat_");
    expect(params.body).toContain("[REDACTED]");
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
