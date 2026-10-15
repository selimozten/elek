/**
 * Tests for trigger detection and actor filtering.
 * Pure logic — no GitHub API calls, no env reads.
 */
import { describe, it, expect } from "bun:test";
import {
  DEFAULT_REVIEW_REQUEST,
  detectTrigger,
  isActorAllowed,
  isActorAuthorized,
} from "../src/github/trigger";
import type { ActionInputs, GitHubEntityContext } from "../src/types";

const baseInputs: ActionInputs = {
  triggerPhrase: "@pi",
  provider: "deepseek",
  model: "",
  thinking: "medium",
  prompt: "",
  autoReview: true,
  systemPrompt: "",
  maxTurns: 20,
  runTimeoutSeconds: 600,
  tools: "",
  configPath: ".elek.yml",
  branchPrefix: "elek/",
  actorFilter: "",
  allowedBots: "",
  stickyComment: true,
  mode: "review",
  reviewStrategy: "solo",
  reviewModels: "",
  reviewAgentCount: undefined,
  validatorModel: "",
  validatorThinking: "",
  severityThreshold: "",
  showCost: true,
  costRates: "",
};

const baseCtx: GitHubEntityContext = {
  eventName: "pull_request",
  eventAction: "opened",
  actor: "alice",
  actorAssociation: "MEMBER",
  repo: { owner: "o", repo: "r", fullName: "o/r", defaultBranch: "main" },
  entityNumber: 1,
  isPR: true,
  triggerText: "",
};

const prCommentCtx: GitHubEntityContext = {
  ...baseCtx,
  eventName: "issue_comment",
  eventAction: "created",
};

describe("detectTrigger", () => {
  it("returns the explicit prompt input when set, regardless of trigger text", () => {
    const result = detectTrigger(
      { ...baseCtx, triggerText: "no mention here" },
      { ...baseInputs, prompt: "do the thing" },
    );
    expect(result).toBe("do the thing");
  });

  it("extracts text after the trigger phrase", () => {
    const result = detectTrigger(
      { ...baseCtx, triggerText: "Hey @pi please review this" },
      baseInputs,
    );
    expect(result).toBe("please review this");
  });

  it("matches the trigger phrase case-insensitively", () => {
    const result = detectTrigger(
      { ...baseCtx, triggerText: "@PI take a look" },
      baseInputs,
    );
    expect(result).toBe("take a look");
  });

  it("returns the full trigger text when @pi is the only content", () => {
    const result = detectTrigger(
      { ...baseCtx, triggerText: "@pi" },
      baseInputs,
    );
    // afterTrigger is empty → falls back to full triggerText
    expect(result).toBe("@pi");
  });

  it("returns null when neither prompt nor trigger phrase is present", () => {
    const result = detectTrigger(
      { ...prCommentCtx, triggerText: "just a regular comment" },
      baseInputs,
    );
    expect(result).toBeNull();
  });

  it("does not match trigger phrases inside longer words", () => {
    expect(detectTrigger(
      { ...prCommentCtx, triggerText: "The @piano config changed" },
      baseInputs,
    )).toBeNull();
    expect(detectTrigger(
      { ...prCommentCtx, triggerText: "Please ping x@pi for details" },
      baseInputs,
    )).toBeNull();
  });

  it("triggers via 'pi' label on issues", () => {
    const result = detectTrigger(
      {
        ...baseCtx,
        isPR: false,
        eventName: "issues",
        triggerText: "no mention",
        issue: { title: "t", body: "b", labels: ["pi"], assignees: [] },
      },
      baseInputs,
    );
    expect(result).toBe("no mention");
  });

  it("does not trigger on unrelated labels", () => {
    const result = detectTrigger(
      {
        ...baseCtx,
        isPR: false,
        eventName: "issues",
        triggerText: "no mention",
        issue: { title: "t", body: "b", labels: ["bug", "p1"], assignees: [] },
      },
      baseInputs,
    );
    expect(result).toBeNull();
  });
});

describe("detectTrigger auto-review", () => {
  const prCtx = (eventAction: string, pr: Partial<NonNullable<GitHubEntityContext["pr"]>> = {}) => ({
    ...baseCtx,
    eventAction,
    triggerText: "Adds a parser",
    pr: {
      title: "t",
      body: "Adds a parser",
      headRef: "feature/x",
      baseRef: "main",
      headSha: "h",
      baseSha: "b",
      draft: false,
      ...pr,
    },
  });

  for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
    it(`reviews pull_request.${action} without a prompt or trigger phrase`, () => {
      expect(detectTrigger(prCtx(action), baseInputs)).toBe(DEFAULT_REVIEW_REQUEST);
    });
  }

  it("ignores pull_request actions that do not change the code under review", () => {
    for (const action of ["closed", "edited", "labeled", "assigned", "converted_to_draft"]) {
      expect(detectTrigger(prCtx(action), baseInputs)).toBeNull();
    }
  });

  it("skips draft pull requests", () => {
    expect(detectTrigger(prCtx("opened", { draft: true }), baseInputs)).toBeNull();
    expect(detectTrigger(prCtx("synchronize", { draft: true }), baseInputs)).toBeNull();
  });

  it("keeps the explicit prompt input ahead of the default request", () => {
    expect(detectTrigger(prCtx("synchronize"), { ...baseInputs, prompt: "focus on auth" })).toBe("focus on auth");
  });

  it("keeps the trigger phrase in the PR body ahead of the default request", () => {
    expect(detectTrigger(
      { ...prCtx("opened"), triggerText: "@pi check the migration" },
      baseInputs,
    )).toBe("check the migration");
  });

  it("can be disabled with auto_review: false", () => {
    expect(detectTrigger(prCtx("opened"), { ...baseInputs, autoReview: false })).toBeNull();
  });

  it("does not auto-trigger agent mode, which can push commits", () => {
    expect(detectTrigger(prCtx("opened"), { ...baseInputs, mode: "agent" })).toBeNull();
    expect(detectTrigger(prCtx("opened"), { ...baseInputs, mode: "review+edit" })).toBe(DEFAULT_REVIEW_REQUEST);
  });

  it("leaves comment, review, and issue events on explicit triggers", () => {
    for (const eventName of ["issue_comment", "pull_request_review", "pull_request_review_comment"] as const) {
      expect(detectTrigger(
        { ...prCtx("created"), eventName, triggerText: "looks good" },
        baseInputs,
      )).toBeNull();
      expect(detectTrigger(
        { ...prCtx("created"), eventName, triggerText: "@pi why?" },
        baseInputs,
      )).toBe("why?");
    }
    expect(detectTrigger(
      {
        ...baseCtx,
        eventName: "issues",
        eventAction: "opened",
        isPR: false,
        triggerText: "bug report",
        issue: { title: "t", body: "bug report", labels: [], assignees: [] },
      },
      baseInputs,
    )).toBeNull();
  });
});

describe("isActorAllowed", () => {
  it("allows trusted repository actors by default", () => {
    expect(isActorAllowed({ ...baseCtx, actor: "alice", actorAssociation: "OWNER" }, baseInputs)).toBe(true);
    expect(isActorAllowed({ ...baseCtx, actor: "alice", actorAssociation: "MEMBER" }, baseInputs)).toBe(true);
    expect(isActorAllowed({ ...baseCtx, actor: "alice", actorAssociation: "COLLABORATOR" }, baseInputs)).toBe(true);
  });

  it("blocks bots by default", () => {
    expect(isActorAllowed({ ...baseCtx, actor: "dependabot[bot]" }, baseInputs)).toBe(false);
  });

  it("blocks untrusted humans by default", () => {
    expect(isActorAllowed({ ...baseCtx, actor: "mallory", actorAssociation: "CONTRIBUTOR" }, baseInputs)).toBe(false);
    expect(isActorAllowed({ ...baseCtx, actor: "mallory", actorAssociation: undefined }, baseInputs)).toBe(false);
  });

  it("respects an explicit actorFilter allowlist", () => {
    const inputs = { ...baseInputs, actorFilter: "alice,bob" };
    expect(isActorAllowed({ ...baseCtx, actor: "alice" }, inputs)).toBe(true);
    expect(isActorAllowed({ ...baseCtx, actor: "carol" }, inputs)).toBe(false);
    expect(isActorAllowed({ ...baseCtx, actor: "untrusted[bot]" }, inputs)).toBe(false);
  });

  it("allows specific bots via allowedBots", () => {
    const inputs = { ...baseInputs, allowedBots: "renovate[bot]" };
    expect(isActorAllowed({ ...baseCtx, actor: "renovate[bot]" }, inputs)).toBe(true);
    expect(isActorAllowed({ ...baseCtx, actor: "dependabot[bot]" }, inputs)).toBe(false);
  });

  it("'*' wildcard allows everything including bots", () => {
    const inputs = { ...baseInputs, allowedBots: "*" };
    expect(isActorAllowed({ ...baseCtx, actor: "dependabot[bot]" }, inputs)).toBe(true);
  });
});

describe("isActorAuthorized", () => {
  it("falls back to live repository permission when webhook association is stale", async () => {
    const permissions: string[] = [];
    const allowed = await isActorAuthorized(
      { ...baseCtx, actor: "alice", actorAssociation: "NONE" },
      baseInputs,
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

    expect(await isActorAuthorized(staleContext, baseInputs, async () => "read")).toBe(false);
    expect(await isActorAuthorized(staleContext, baseInputs, async () => {
      throw new Error("permission API unavailable");
    })).toBe(false);
  });

  it("does not use permission fallback to bypass explicit actor or bot filters", async () => {
    let lookupCalls = 0;
    const lookup = async () => {
      lookupCalls += 1;
      return "admin";
    };

    expect(await isActorAuthorized(
      { ...baseCtx, actor: "alice", actorAssociation: "NONE" },
      { ...baseInputs, actorFilter: "bob" },
      lookup,
    )).toBe(false);
    expect(await isActorAuthorized(
      { ...baseCtx, actor: "dependabot[bot]", actorAssociation: "NONE" },
      baseInputs,
      lookup,
    )).toBe(false);
    expect(lookupCalls).toBe(0);
  });
});
