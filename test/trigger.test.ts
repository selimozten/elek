/**
 * Tests for the review gate and actor authorization.
 * Pure logic — no GitHub API calls, no env reads.
 */
import { describe, it, expect } from "bun:test";
import { isActorAuthorized, shouldReview } from "../src/github/trigger";
import type { GitHubEntityContext } from "../src/types";

const baseCtx: GitHubEntityContext = {
  eventAction: "opened",
  actor: "alice",
  actorAssociation: "MEMBER",
  repo: { owner: "o", repo: "r", fullName: "o/r", defaultBranch: "main" },
  entityNumber: 1,
  pr: {
    title: "t",
    body: "Adds a parser",
    headRef: "feature/x",
    baseRef: "main",
    headSha: "h",
    baseSha: "b",
    draft: false,
  },
};

const prCtx = (eventAction: string, pr: Partial<GitHubEntityContext["pr"]> = {}): GitHubEntityContext => ({
  ...baseCtx,
  eventAction,
  pr: { ...baseCtx.pr, ...pr },
});

describe("shouldReview", () => {
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
    it(`reviews pull_request.${action}`, () => {
      expect(shouldReview(prCtx(action))).toBe(true);
    });
  }

  it("ignores pull_request actions that do not change the code under review", () => {
    for (const action of ["closed", "edited", "labeled", "assigned", "converted_to_draft"]) {
      expect(shouldReview(prCtx(action))).toBe(false);
    }
  });

  it("skips draft pull requests", () => {
    expect(shouldReview(prCtx("opened", { draft: true }))).toBe(false);
    expect(shouldReview(prCtx("synchronize", { draft: true }))).toBe(false);
  });
});

describe("isActorAuthorized", () => {
  it("allows trusted repository actors from the webhook association", async () => {
    for (const actorAssociation of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(await isActorAuthorized({ ...baseCtx, actorAssociation })).toBe(true);
    }
  });

  it("blocks untrusted humans without a permission lookup", async () => {
    expect(await isActorAuthorized({ ...baseCtx, actor: "mallory", actorAssociation: "CONTRIBUTOR" })).toBe(false);
    expect(await isActorAuthorized({ ...baseCtx, actor: "mallory", actorAssociation: undefined })).toBe(false);
  });

  it("falls back to live repository permission when webhook association is stale", async () => {
    const permissions: string[] = [];
    const allowed = await isActorAuthorized(
      { ...baseCtx, actor: "alice", actorAssociation: "NONE" },
      async ({ owner, repo, actor }) => {
        expect({ owner, repo, actor }).toEqual({ owner: "o", repo: "r", actor: "alice" });
        permissions.push("checked");
        return "write";
      },
    );

    expect(allowed).toBe(true);
    expect(permissions).toEqual(["checked"]);
  });

  it("fails closed for public read access and permission lookup failures", async () => {
    const staleContext = { ...baseCtx, actor: "mallory", actorAssociation: "NONE" };

    expect(await isActorAuthorized(staleContext, async () => "read")).toBe(false);
    expect(await isActorAuthorized(staleContext, async () => {
      throw new Error("permission API unavailable");
    })).toBe(false);
  });

  it("blocks bots even with a trusted association or admin permission", async () => {
    let lookupCalls = 0;
    const lookup = async () => {
      lookupCalls += 1;
      return "admin";
    };

    expect(await isActorAuthorized({ ...baseCtx, actor: "dependabot[bot]", actorAssociation: "MEMBER" }, lookup)).toBe(false);
    expect(await isActorAuthorized({ ...baseCtx, actor: "dependabot[bot]", actorAssociation: "NONE" }, lookup)).toBe(false);
    expect(lookupCalls).toBe(0);
  });
});
