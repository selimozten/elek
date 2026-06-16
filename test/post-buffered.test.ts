/**
 * Tests for the post-step that drains the inline-comment buffer.
 * Uses an in-memory file double so we never touch /tmp.
 */
import { describe, it, expect } from "bun:test";
import {
  commentableLinesForPatch,
  postBuffered,
  type PostBufferedDeps,
} from "../src/entrypoints/post-buffered";
import { stableInlineFindingId } from "../src/review/finding-markers";

function makeDeps(overrides: Partial<PostBufferedDeps> = {}): {
  deps: PostBufferedDeps;
  calls: { args: unknown }[];
} {
  const calls: { args: unknown }[] = [];
  return {
    calls,
    deps: {
      readBuffer: () => "",
      octokit: {
        pulls: {
          createReviewComment: async (args: unknown) => {
            calls.push({ args });
            return { data: { id: 1 } };
          },
          get: async () => ({ data: { head: { sha: "headsha" } } }),
        },
      },
      env: { repoOwner: "octo", repoName: "repo", prNumber: "1" },
      log: () => {},
      ...overrides,
    },
  };
}

describe("postBuffered", () => {
  it("parses commentable LEFT and RIGHT diff lines from a patch", () => {
    const lines = commentableLinesForPatch(
      [
        "@@ -10,3 +10,4 @@",
        " context",
        "-old",
        "+new",
        "+extra",
        " tail",
      ].join("\n"),
    );

    expect([...lines.LEFT].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect([...lines.RIGHT].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });

  it("parses single-line hunks and deletion-only changes", () => {
    const lines = commentableLinesForPatch(
      [
        "@@ -4 +4 @@",
        "-old",
        "@@ -10,2 +9,0 @@",
        "-removed",
        "-also removed",
      ].join("\n"),
    );

    expect([...lines.LEFT].sort((a, b) => a - b)).toEqual([4, 10, 11]);
    expect([...lines.RIGHT].sort((a, b) => a - b)).toEqual([]);
  });

  it("returns no commentable lines when patch text is unavailable", () => {
    const lines = commentableLinesForPatch(undefined);
    expect(lines.LEFT.size).toBe(0);
    expect(lines.RIGHT.size).toBe(0);
  });

  it("does nothing when the buffer is empty", async () => {
    const { deps, calls } = makeDeps();
    const summary = await postBuffered(deps);
    expect(summary).toMatchObject({ posted: 0, skipped: 0, failed: 0 });
    expect(calls.length).toBe(0);
  });

  it("skips entries where confirmed===false (explicit opt-out)", async () => {
    const buffer = [
      JSON.stringify({ path: "src/a.ts", line: 1, body: "real", confirmed: undefined }),
      JSON.stringify({ path: "src/b.ts", line: 2, body: "do not post", confirmed: false }),
    ].join("\n") + "\n";

    const { deps, calls } = makeDeps({ readBuffer: () => buffer });
    const summary = await postBuffered(deps);

    expect(summary.posted).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(calls.length).toBe(1);
    expect((calls[0].args as Record<string, unknown>).path).toBe("src/a.ts");
  });

  it("continues posting after a single entry fails", async () => {
    const buffer = [
      JSON.stringify({ path: "src/a.ts", line: 1, body: "first" }),
      JSON.stringify({ path: "src/b.ts", line: 999, body: "bad line" }),
      JSON.stringify({ path: "src/c.ts", line: 3, body: "third" }),
    ].join("\n") + "\n";

    const calls: { args: unknown }[] = [];
    let n = 0;
    const deps: PostBufferedDeps = {
      readBuffer: () => buffer,
      octokit: {
        pulls: {
          createReviewComment: async (args: unknown) => {
            n++;
            calls.push({ args });
            if (n === 2) throw new Error("Validation Failed: line 999 not in diff");
            return { data: { id: n } };
          },
          get: async () => ({ data: { head: { sha: "headsha" } } }),
        },
      },
      env: { repoOwner: "octo", repoName: "repo", prNumber: "1" },
    };

    const summary = await postBuffered(deps);
    expect(summary.posted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(calls.length).toBe(3); // all three were attempted
  });

  it("posts each buffered entry as a PR review comment", async () => {
    const buffer = [
      JSON.stringify({ path: "src/a.ts", line: 10, body: "nit" }),
      JSON.stringify({ path: "src/b.ts", startLine: 5, line: 8, body: "logic", side: "LEFT" }),
    ].join("\n") + "\n";

    const { deps, calls } = makeDeps({ readBuffer: () => buffer });
    const summary = await postBuffered(deps);

    expect(summary.posted).toBe(2);
    expect(calls.length).toBe(2);

    const single = calls[0].args as Record<string, unknown>;
    expect(single).toMatchObject({
      owner: "octo",
      repo: "repo",
      pull_number: 1,
      path: "src/a.ts",
      line: 10,
      side: "RIGHT",
      commit_id: "headsha",
    });
    expect(single.body).toContain("nit");
    expect(single.body).toContain("<!-- elek-finding:v1 id=");

    const multi = calls[1].args as Record<string, unknown>;
    expect(multi).toMatchObject({
      path: "src/b.ts",
      start_line: 5,
      start_side: "LEFT",
      line: 8,
      side: "LEFT",
    });
  });

  it("posts buffered entries as one PR review when supported", async () => {
    const buffer = [
      JSON.stringify({ path: "src/a.ts", line: 10, body: "nit" }),
      JSON.stringify({ path: "src/b.ts", startLine: 5, line: 8, body: "logic", side: "LEFT" }),
    ].join("\n") + "\n";

    const groupedCalls: { args: unknown }[] = [];
    const { deps, calls } = makeDeps({ readBuffer: () => buffer });
    deps.octokit.pulls.createReview = async (args: unknown) => {
      groupedCalls.push({ args });
      return { data: { id: 123 } };
    };

    const summary = await postBuffered(deps);

    expect(summary).toMatchObject({ posted: 2, skipped: 0, failed: 0 });
    expect(calls.length).toBe(0);
    expect(groupedCalls.length).toBe(1);

    const review = groupedCalls[0].args as Record<string, unknown>;
    expect(review).toMatchObject({
      owner: "octo",
      repo: "repo",
      pull_number: 1,
      event: "COMMENT",
      commit_id: "headsha",
    });
    expect(review.comments).toMatchObject([
      {
        path: "src/a.ts",
        line: 10,
        side: "RIGHT",
      },
      {
        path: "src/b.ts",
        start_line: 5,
        start_side: "LEFT",
        line: 8,
        side: "LEFT",
      },
    ]);
    const comments = review.comments as Array<Record<string, unknown>>;
    expect(comments[0].body).toContain("nit");
    expect(comments[1].body).toContain("logic");
    expect(comments[0].body).toContain("<!-- elek-finding:v1 id=");
  });

  it("falls back to individual comments when grouped review creation fails", async () => {
    const buffer = [
      JSON.stringify({ path: "src/a.ts", line: 10, body: "first" }),
      JSON.stringify({ path: "src/b.ts", line: 12, body: "second" }),
    ].join("\n") + "\n";

    const groupedCalls: { args: unknown }[] = [];
    const logs: string[] = [];
    const { deps, calls } = makeDeps({
      readBuffer: () => buffer,
      log: (msg) => logs.push(msg),
    });
    deps.octokit.pulls.createReview = async (args: unknown) => {
      groupedCalls.push({ args });
      throw new Error("secondary rate limit");
    };

    const summary = await postBuffered(deps);

    expect(summary).toMatchObject({ posted: 2, skipped: 0, failed: 0 });
    expect(groupedCalls.length).toBe(1);
    expect(calls.length).toBe(2);
    expect(logs.some((msg) => msg.includes("falling back"))).toBe(true);
  });

  it("skips buffered entries that do not anchor to PR diff lines when file data is available", async () => {
    const buffer = [
      JSON.stringify({ path: "src/a.ts", line: 11, body: "valid" }),
      JSON.stringify({ path: "src/a.ts", line: 50, body: "invalid" }),
      JSON.stringify({ path: "src/missing.ts", line: 1, body: "missing" }),
    ].join("\n") + "\n";

    const { deps, calls } = makeDeps({
      readBuffer: () => buffer,
    });
    deps.octokit.pulls.listFiles = async () => ({
      data: [
        {
          filename: "src/a.ts",
          patch: ["@@ -10,2 +10,2 @@", " context", "+added"].join("\n"),
        },
      ],
    });

    const summary = await postBuffered(deps);

    expect(summary.posted).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.failed).toBe(0);
    expect(calls.length).toBe(1);
    expect((calls[0].args as Record<string, unknown>).body).toContain("valid");
  });

  it("skips duplicate elek findings already posted on the PR", async () => {
    const entry = { path: "src/a.ts", line: 10, body: "same finding" };
    const findingId = stableInlineFindingId(entry);
    const buffer = JSON.stringify(entry) + "\n";

    const { deps, calls } = makeDeps({ readBuffer: () => buffer });
    deps.octokit.pulls.listReviewComments = async () => ({
      data: [{ body: `same finding\n\n<!-- elek-finding:v1 id=${findingId} -->` }],
    });

    const summary = await postBuffered(deps);

    expect(summary.posted).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.duplicate).toBe(1);
    expect(calls.length).toBe(0);
  });
});
