/**
 * Tests for the post-step that drains the inline-comment buffer.
 * Uses an in-memory file double so we never touch /tmp.
 */
import { describe, it, expect } from "bun:test";
import { postBuffered, type PostBufferedDeps } from "../src/entrypoints/post-buffered";

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
      body: "nit",
      side: "RIGHT",
      commit_id: "headsha",
    });

    const multi = calls[1].args as Record<string, unknown>;
    expect(multi).toMatchObject({
      path: "src/b.ts",
      start_line: 5,
      start_side: "LEFT",
      line: 8,
      side: "LEFT",
    });
  });
});
