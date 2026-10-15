import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import {
  createPRReview,
  createTrackingComment,
  fetchReviewComments,
  postComment,
  updateTrackingComment,
} from "../src/github/comments";
import type { GitHubEntityContext } from "../src/types";

const context: GitHubEntityContext = {
  eventAction: "opened",
  actor: "alice",
  repo: {
    owner: "selimozten",
    repo: "elek",
    fullName: "selimozten/elek",
    defaultBranch: "main",
  },
  entityNumber: 22,
  pr: {
    title: "Brand refresh",
    body: "",
    headRef: "brand/minimal-identity",
    baseRef: "main",
    headSha: "abc",
    baseSha: "def",
  },
};

function trackingLane(modelLabel: string): string {
  return createHash("sha256")
    .update(modelLabel.trim().toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

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
                user: { login: "github-actions[bot]" },
                body: "old kimi review\n\n<!-- elek-bot:together/kimi -->",
              },
              {
                id: 2,
                html_url: "https://example.test/comment/2",
                user: { login: "github-actions[bot]" },
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
                user: { login: "github-actions[bot]" },
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

  it("does not reuse a forged tracking signature from a human comment author", async () => {
    const modelLabel = "deepseek/deepseek-v4-pro";
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
                user: { login: "mallory" },
                body: `looks official\n\n<!-- elek-bot:lane:${trackingLane(modelLabel)} -->`,
              },
            ],
          }),
          updateComment: async (params: any) => {
            updates.push(params);
            return { data: {} };
          },
          createComment: async (params: any) => {
            creates.push(params);
            return { data: { id: 125, html_url: "https://example.test/comment/125" } };
          },
        },
        pulls: {
          createReview: async () => ({ data: {} }),
          listReviews: async () => ({ data: [] }),
          listReviewComments: async () => ({ data: [] }),
        },
      },
    };

    const result = await createTrackingComment(octokit, context, modelLabel);

    expect(result.id).toBe(125);
    expect(creates).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it("uses the latest lane signature when an old comment body contains a stale lane", async () => {
    const modelLabel = "deepseek/deepseek-v4-pro";
    const updates: Array<Record<string, unknown>> = [];
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              {
                id: 11,
                html_url: "https://example.test/comment/11",
                user: { login: "github-actions[bot]" },
                body:
                  "old review\n\n<!-- elek-bot:lane:aaaaaaaaaaaa -->\n\n" +
                  `<!-- elek-bot:lane:${trackingLane(modelLabel)} -->`,
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

    const result = await createTrackingComment(octokit, context, modelLabel);

    expect(result.id).toBe(11);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ comment_id: 11 });
  });

  it("normalizes tracking updates to one final lane signature", async () => {
    let updatedBody = "";
    const modelLabel = "openrouter/moonshotai/kimi-k2.7-code";
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          updateComment: async (params: any) => {
            updatedBody = params.body;
            return { data: {} };
          },
          createComment: async () => ({ data: {} }),
        },
        pulls: {
          createReview: async () => ({ data: {} }),
          listReviews: async () => ({ data: [] }),
          listReviewComments: async () => ({ data: [] }),
        },
      },
    };

    await updateTrackingComment(
      octokit,
      context,
      12,
      "review body\n\n<!-- elek-bot -->\n\n<!-- elek-bot:lane:aaaaaaaaaaaa -->",
      modelLabel,
    );

    const laneMatches = updatedBody.match(/<!-- elek-bot:lane:[a-f0-9]{12} -->/g) || [];
    expect(laneMatches).toHaveLength(1);
    expect(updatedBody).not.toContain("<!-- elek-bot -->");
    expect(updatedBody).not.toContain("aaaaaaaaaaaa");
    expect(updatedBody).toContain(`<!-- elek-bot:lane:${trackingLane(modelLabel)} -->`);
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
                user: { login: "github-actions[bot]" },
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

describe("review comment context", () => {
  it("excludes Elek review bodies and inline findings", async () => {
    const comments = await fetchReviewComments(
      {
        rest: {
          pulls: {
            listReviews: async () => ({
              data: [
                {
                  state: "COMMENTED",
                  body: "<p><strong>elek</strong> review: analysis complete</p>\n\nstale finding",
                },
                { state: "COMMENTED", body: "Claude found a current issue" },
              ],
            }),
            listReviewComments: async () => ({
              data: [
                {
                  path: "src/a.ts",
                  line: 4,
                  body: "stale Elek inline finding\n\n<!-- elek-finding:v1 id=aaaaaaaaaaaaaaaa -->",
                },
                { path: "src/b.ts", line: 9, body: "human inline comment" },
              ],
            }),
          },
        },
      } as any,
      context,
    );

    expect(comments).toEqual([
      "[Review: COMMENTED]: Claude found a current issue",
      "[src/b.ts:9]: human inline comment",
    ]);
  });
});

describe("review delivery without a tracking comment", () => {
  it("posts a COMMENT review and never approves", async () => {
    const reviews: any[] = [];
    const octokit = { rest: { pulls: { createReview: async (params: any) => reviews.push(params) } } } as any;

    await createPRReview(octokit, context, "## Findings\nNo high-confidence findings.", "success", "deepseek/v4");
    await createPRReview(octokit, context, "Elek could not complete this review run.", "failure", "deepseek/v4");

    expect(reviews.map((review) => review.event)).toEqual(["COMMENT", "COMMENT"]);
    expect(reviews[0]).toMatchObject({ owner: "selimozten", repo: "elek", pull_number: 22 });
    expect(reviews[0].body).toContain("analysis complete");
    expect(reviews[0].body).toContain("No high-confidence findings.");
    expect(reviews[1].body).toContain("encountered an issue");
  });

  it("signs fallback comments with the model lane", async () => {
    const comments: any[] = [];
    const octokit = { rest: { issues: { createComment: async (params: any) => comments.push(params) } } } as any;

    await postComment(octokit, context, "review body", "deepseek/v4");

    const lane = createHash("sha256").update("deepseek/v4").digest("hex").slice(0, 12);
    expect(comments[0]).toMatchObject({ issue_number: 22 });
    expect(comments[0].body).toBe(`review body\n\n<!-- elek-bot:lane:${lane} -->`);
  });
});
