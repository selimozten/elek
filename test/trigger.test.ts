/**
 * Tests for trigger detection and actor filtering.
 * Pure logic — no GitHub API calls, no env reads.
 */
import { describe, it, expect } from "bun:test";
import { detectTrigger, isActorAllowed } from "../src/github/trigger";
import type { ActionInputs, GitHubEntityContext } from "../src/types";

const baseInputs: ActionInputs = {
  triggerPhrase: "@pi",
  provider: "deepseek",
  model: "",
  thinking: "medium",
  prompt: "",
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
      { ...baseCtx, triggerText: "just a regular comment" },
      baseInputs,
    );
    expect(result).toBeNull();
  });

  it("does not match trigger phrases inside longer words", () => {
    expect(detectTrigger(
      { ...baseCtx, triggerText: "The @piano config changed" },
      baseInputs,
    )).toBeNull();
    expect(detectTrigger(
      { ...baseCtx, triggerText: "Please ping x@pi for details" },
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
