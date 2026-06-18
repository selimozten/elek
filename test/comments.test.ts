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
  it("uses one stable hidden tracking signature instead of model-specific signatures", async () => {
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

    expect(postedBody).toContain("<!-- elek-bot -->");
    expect(postedBody).not.toContain("openrouter/<foo&bar-->baz");
  });

  it("reuses the newest legacy model-specific comment and marks older ones superseded", async () => {
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
                body: "old qwen review\n\n<!-- elek-bot:together/qwen -->",
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

    const result = await createTrackingComment(octokit, context, "openai/gpt-5.5");

    expect(result.id).toBe(2);
    expect(updates.length).toBe(2);
    expect(updates[0]).toMatchObject({ comment_id: 2 });
    expect(String(updates[0].body)).toContain("<!-- elek-bot -->");
    expect(updates[1]).toMatchObject({ comment_id: 1 });
    expect(String(updates[1].body)).toContain("superseded by a newer run");
    expect(String(updates[1].body)).toContain("old kimi review");
  });
});
