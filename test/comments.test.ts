import { describe, expect, it } from "bun:test";
import { createTrackingComment } from "../src/github/comments";
import type { GitHubEntityContext } from "../src/types";

const context: GitHubEntityContext = {
  eventName: "pull_request",
  eventAction: "opened",
  actor: "alice",
  repo: {
    owner: "selimozten",
    repo: "elek",
    fullName: "selimozten/elek",
    defaultBranch: "main",
  },
  entityNumber: 22,
  isPR: true,
  triggerText: "",
  pr: {
    title: "Brand refresh",
    body: "",
    headRef: "brand/minimal-identity",
    baseRef: "main",
    headSha: "abc",
    baseSha: "def",
  },
};

describe("comment branding", () => {
  it("uses a stable hidden tracking lane without embedding the raw model label", async () => {
    let postedBody = "";
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          updateComment: async () => ({ data: {} }),
          createComment: async (params: any) => {
            postedBody = params.body;
            return { data: { id: 123, html_url: "https://example.test/comment/123" } };
          },
        },
        pulls: {
          createReview: async () => ({ data: {} }),
          listReviews: async () => ({ data: [] }),
          listReviewComments: async () => ({ data: [] }),
        },
      },
    };

    await createTrackingComment(octokit, context, "openrouter/<foo&bar-->baz");

    expect(postedBody).toMatch(/<!-- elek-bot:lane:[a-f0-9]{12} -->/);
    expect(postedBody).not.toContain("openrouter/<foo&bar-->baz");
  });

  it("reuses only the matching model lane and leaves other model lanes active", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              {
                id: 1,
                html_url: "https://example.test/comment/1",
                body: "old kimi review\n\n<!-- elek-bot:together/kimi -->",
              },
              {
                id: 2,
                html_url: "https://example.test/comment/2",
                body: "old deepseek review\n\n<!-- elek-bot:deepseek/deepseek-v4-pro -->",
              },
            ],
          }),
          updateComment: async (params: any) => {
            updates.push(params);
            return { data: {} };
          },
          createComment: async () => {
            throw new Error("should reuse existing comment");
          },
        },
        pulls: {
          createReview: async () => ({ data: {} }),
          listReviews: async () => ({ data: [] }),
          listReviewComments: async () => ({ data: [] }),
        },
      },
    };

    const result = await createTrackingComment(octokit, context, "deepseek/deepseek-v4-pro");

    expect(result.id).toBe(2);
    expect(updates.length).toBe(1);
    expect(updates[0]).toMatchObject({ comment_id: 2 });
    expect(String(updates[0].body)).toMatch(/<!-- elek-bot:lane:[a-f0-9]{12} -->/);
    expect(String(updates[0].body)).not.toContain("deepseek/deepseek-v4-pro -->");
  });

  it("does not let a different model overwrite an existing scoped tracking comment", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const creates: Array<Record<string, unknown>> = [];
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              {
                id: 10,
                html_url: "https://example.test/comment/10",
                body: "active kimi review\n\n<!-- elek-bot:lane:aaaaaaaaaaaa -->",
              },
            ],
          }),
          updateComment: async (params: any) => {
            updates.push(params);
            return { data: {} };
          },
          createComment: async (params: any) => {
            creates.push(params);
            return { data: { id: 123, html_url: "https://example.test/comment/123" } };
          },
        },
        pulls: {
          createReview: async () => ({ data: {} }),
          listReviews: async () => ({ data: [] }),
          listReviewComments: async () => ({ data: [] }),
        },
      },
    };

    const result = await createTrackingComment(octokit, context, "deepseek/deepseek-v4-pro");

    expect(result.id).toBe(123);
    expect(creates).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it("migrates away from an unscoped global comment instead of reusing it across lanes", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const creates: Array<Record<string, unknown>> = [];
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              {
                id: 20,
                html_url: "https://example.test/comment/20",
                body: "old global review\n\n<!-- elek-bot -->",
              },
            ],
          }),
          updateComment: async (params: any) => {
            updates.push(params);
            return { data: {} };
          },
          createComment: async (params: any) => {
            creates.push(params);
            return { data: { id: 124, html_url: "https://example.test/comment/124" } };
          },
        },
        pulls: {
          createReview: async () => ({ data: {} }),
          listReviews: async () => ({ data: [] }),
          listReviewComments: async () => ({ data: [] }),
        },
      },
    };

    const result = await createTrackingComment(octokit, context, "openai/gpt-5.5");

    expect(result.id).toBe(124);
    expect(creates).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ comment_id: 20 });
    expect(String(updates[0].body)).toContain("superseded by a newer run");
  });
});
