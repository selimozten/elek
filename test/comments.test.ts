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
  it("keeps model labels from breaking the hidden tracking signature", async () => {
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

    await createTrackingComment(octokit, context, "openrouter/foo-->bar");

    expect(postedBody).toContain("<!-- elek-bot:openrouter/foo- -&gt;bar -->");
    expect(postedBody).not.toContain("<!-- elek-bot:openrouter/foo-->bar -->");
  });
});
