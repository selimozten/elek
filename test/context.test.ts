/**
 * Tests for parseEntityContext — turning raw GitHub event payloads
 * into the canonical GitHubEntityContext used everywhere downstream.
 *
 * Strategy: write a fake event JSON to RUNNER_TEMP, set GITHUB_EVENT_PATH
 * and GITHUB_EVENT_NAME, then assert against the parsed result.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseEntityContext, parseInputs } from "../src/github/context";

let tmp: string;
const ENV_KEYS = [
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_ACTOR",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_OWNER",
  "INPUT_BRANCH_PREFIX",
  "INPUT_CONFIG_PATH",
  "INPUT_STICKY_COMMENT",
  "INPUT_SHOW_COST",
  "INPUT_COST_RATES",
  "INPUT_REVIEW_LENSES",
  "INPUT_REVIEW_AGENT_COUNT",
  "INPUT_ADVISOR_MODEL",
  "INPUT_ADVISOR_THINKING",
  "INPUT_VALIDATOR_THINKING",
  "INPUT_MAX_COST_USD",
  "INPUT_MAX_COUNCIL_CHANGED_LINES",
  "INPUT_MAX_CROSSCHECK_CHANGED_LINES",
  "INPUT_RUN_TIMEOUT_SECONDS",
];
const saved: Record<string, string | undefined> = {};

function writeEvent(payload: unknown): string {
  const path = join(tmp, "event.json");
  writeFileSync(path, JSON.stringify(payload), "utf-8");
  return path;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "elek-test-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.GITHUB_REPOSITORY = "octo/repo";
  process.env.GITHUB_REPOSITORY_OWNER = "octo";
  process.env.GITHUB_ACTOR = "alice";
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("parseEntityContext", () => {
  it("parses a pull_request opened event", () => {
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "opened",
      pull_request: {
        number: 42,
        title: "Add feature",
        body: "fixes #1",
        head: { ref: "feat/x", sha: "headsha" },
        base: { ref: "main", sha: "basesha" },
      },
      repository: { default_branch: "main" },
    });

    const ctx = parseEntityContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.eventName).toBe("pull_request");
    expect(ctx!.isPR).toBe(true);
    expect(ctx!.entityNumber).toBe(42);
    expect(ctx!.actor).toBe("alice");
    expect(ctx!.pr?.headRef).toBe("feat/x");
    expect(ctx!.pr?.baseRef).toBe("main");
    expect(ctx!.triggerText).toBe("fixes #1");
  });

  it("parses an issues event and extracts labels/assignees", () => {
    process.env.GITHUB_EVENT_NAME = "issues";
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "labeled",
      issue: {
        number: 7,
        title: "Bug",
        body: "broken",
        labels: [{ name: "bug" }, "needs-triage"],
        assignees: [{ login: "bob" }],
      },
    });

    const ctx = parseEntityContext();
    expect(ctx!.isPR).toBe(false);
    expect(ctx!.entityNumber).toBe(7);
    expect(ctx!.issue?.labels).toEqual(["bug", "needs-triage"]);
    expect(ctx!.issue?.assignees).toEqual(["bob"]);
  });

  it("skips PR-as-issue payloads on issues event", () => {
    process.env.GITHUB_EVENT_NAME = "issues";
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "opened",
      issue: { number: 5, pull_request: { url: "..." }, body: "" },
    });
    expect(parseEntityContext()).toBeNull();
  });

  it("parses an issue_comment event on a PR (sets isPR=true via issue.pull_request)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment";
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "created",
      comment: { body: "@pi review please" },
      issue: { number: 99, title: "PR title", body: "", pull_request: { url: "..." } },
    });

    const ctx = parseEntityContext();
    expect(ctx!.isPR).toBe(true);
    expect(ctx!.eventName).toBe("issue_comment");
    expect(ctx!.entityNumber).toBe(99);
    expect(ctx!.triggerText).toBe("@pi review please");
    expect(ctx!.pr).toBeDefined();
  });

  it("parses an issue_comment event on a plain issue (isPR=false)", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment";
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "created",
      comment: { body: "@pi help" },
      issue: { number: 12, title: "Q", body: "" },
    });

    const ctx = parseEntityContext();
    expect(ctx!.isPR).toBe(false);
    expect(ctx!.issue).toBeDefined();
  });

  it("returns null for unsupported events", () => {
    process.env.GITHUB_EVENT_NAME = "push";
    process.env.GITHUB_EVENT_PATH = writeEvent({ ref: "refs/heads/main" });
    expect(parseEntityContext()).toBeNull();
  });

  it("falls back to payload data when env vars are missing", () => {
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY_OWNER;
    delete process.env.GITHUB_ACTOR;

    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "opened",
      sender: { login: "carol" },
      pull_request: {
        number: 1,
        title: "T",
        body: "B",
        head: { ref: "h", sha: "s" },
        base: { ref: "main", sha: "b" },
      },
      repository: {
        owner: { login: "octo" },
        name: "repo",
        full_name: "octo/repo",
        default_branch: "main",
      },
    });

    const ctx = parseEntityContext();
    expect(ctx!.actor).toBe("carol");
    expect(ctx!.repo.owner).toBe("octo");
    expect(ctx!.repo.repo).toBe("repo");
    expect(ctx!.repo.fullName).toBe("octo/repo");
  });
});

describe("parseInputs", () => {
  it("defaults generated branch names to elek branding", () => {
    delete process.env.INPUT_BRANCH_PREFIX;
    expect(parseInputs().branchPrefix).toBe("elek/");
  });

  it("respects an explicit branch_prefix input", () => {
    process.env.INPUT_BRANCH_PREFIX = "feature/automated-fixes/";
    expect(parseInputs().branchPrefix).toBe("feature/automated-fixes/");
  });

  it("does not default tools to the legacy full-power allowlist", () => {
    delete process.env.INPUT_TOOLS;
    expect(parseInputs().tools).toBe("");
  });

  it("defaults to the repository config file path", () => {
    delete process.env.INPUT_CONFIG_PATH;
    expect(parseInputs().configPath).toBe(".elek.yml");
  });

  it("leaves review_strategy unset so repo config can provide a default", () => {
    delete process.env.INPUT_REVIEW_STRATEGY;
    expect(parseInputs().reviewStrategy).toBe("");
  });

  it("enables cost reporting by default", () => {
    delete process.env.INPUT_SHOW_COST;
    expect(parseInputs().showCost).toBe(true);
  });

  it("can disable cost reporting and parse rate overrides", () => {
    process.env.INPUT_SHOW_COST = "false";
    process.env.INPUT_COST_RATES = "openai/gpt-5.5=1:2";
    process.env.INPUT_REVIEW_AGENT_COUNT = "6";
    process.env.INPUT_REVIEW_LENSES = "security-correctness,contract-drift,mobile-runtime";
    process.env.INPUT_ADVISOR_MODEL = "openai/gpt-5.6-sol";
    process.env.INPUT_ADVISOR_THINKING = "medium";
    process.env.INPUT_VALIDATOR_THINKING = "medium";
    process.env.INPUT_MAX_COST_USD = "0.25";
    process.env.INPUT_MAX_COUNCIL_CHANGED_LINES = "1500";
    process.env.INPUT_MAX_CROSSCHECK_CHANGED_LINES = "0";

    const inputs = parseInputs();
    expect(inputs.showCost).toBe(false);
    expect(inputs.costRates).toBe("openai/gpt-5.5=1:2");
    expect(inputs.reviewAgentCount).toBe(6);
    expect(inputs.reviewLenses).toBe("security-correctness,contract-drift,mobile-runtime");
    expect(inputs.advisorModel).toBe("openai/gpt-5.6-sol");
    expect(inputs.advisorThinking).toBe("medium");
    expect(inputs.validatorThinking).toBe("medium");
    expect(inputs.maxCostUsd).toBe(0.25);
    expect(inputs.maxCouncilChangedLines).toBe(1500);
    expect(inputs.maxCrosscheckChangedLines).toBe(0);
  });

  it("can explicitly disable inherited max_cost_usd action inputs", () => {
    for (const value of ["0", "off", "none", "false", "disabled"]) {
      process.env.INPUT_MAX_COST_USD = value;
      expect(parseInputs().maxCostUsd).toBeNull();
    }
  });

  it("rejects invalid max_cost_usd action inputs", () => {
    for (const value of ["-0.05", "abc", "Infinity", ""]) {
      process.env.INPUT_MAX_COST_USD = value;
      expect(parseInputs().maxCostUsd).toBeUndefined();
    }
  });

  it("rejects invalid review_agent_count action inputs", () => {
    for (const value of ["0", "-1", "1.5", "9", "abc", ""]) {
      process.env.INPUT_REVIEW_AGENT_COUNT = value;
      expect(parseInputs().reviewAgentCount).toBeUndefined();
    }
  });

  it("rejects invalid changed-line guard inputs", () => {
    for (const value of ["-1", "1.5", "abc", "Infinity"]) {
      process.env.INPUT_MAX_COUNCIL_CHANGED_LINES = value;
      process.env.INPUT_MAX_CROSSCHECK_CHANGED_LINES = value;
      expect(parseInputs().maxCouncilChangedLines).toBeUndefined();
      expect(parseInputs().maxCrosscheckChangedLines).toBeUndefined();
    }
  });

  it("parses run_timeout_seconds and falls back on invalid values", () => {
    delete process.env.INPUT_RUN_TIMEOUT_SECONDS;
    expect(parseInputs().runTimeoutSeconds).toBe(600);

    for (const value of ["0", "-10", "1.5", "abc"]) {
      process.env.INPUT_RUN_TIMEOUT_SECONDS = value;
      expect(parseInputs().runTimeoutSeconds).toBe(600);
    }

    process.env.INPUT_RUN_TIMEOUT_SECONDS = "120";
    expect(parseInputs().runTimeoutSeconds).toBe(120);
  });

  it("parses severity_threshold when explicitly set", () => {
    process.env.INPUT_SEVERITY_THRESHOLD = "IMPORTANT";

    expect(parseInputs().severityThreshold).toBe("important");
  });

  it("normalizes boolean-like action inputs", () => {
    process.env.INPUT_SHOW_COST = "OFF";
    process.env.INPUT_STICKY_COMMENT = "0";

    const inputs = parseInputs();
    expect(inputs.showCost).toBe(false);
    expect(inputs.stickyComment).toBe(false);
  });
});
