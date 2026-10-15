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
  "INPUT_CONFIG_PATH",
  "INPUT_STICKY_COMMENT",
  "INPUT_RUN_TIMEOUT_SECONDS",
  "INPUT_SEVERITY_THRESHOLD",
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
    expect(ctx!.eventAction).toBe("opened");
    expect(ctx!.entityNumber).toBe(42);
    expect(ctx!.actor).toBe("alice");
    expect(ctx!.pr?.headRef).toBe("feat/x");
    expect(ctx!.pr?.baseRef).toBe("main");
    expect(ctx!.pr.body).toBe("fixes #1");
    expect(ctx!.pr?.draft).toBe(false);
    expect(ctx!.pr?.isFork).toBe(false);
  });

  it("marks draft and fork pull requests", () => {
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "synchronize",
      pull_request: {
        number: 43,
        draft: true,
        head: { ref: "patch-1", sha: "h", repo: { full_name: "mallory/repo" } },
        base: { ref: "main", sha: "b", repo: { full_name: "octo/repo" } },
      },
    });
    expect(parseEntityContext()!.pr).toMatchObject({ draft: true, isFork: true });

    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "synchronize",
      pull_request: {
        number: 44,
        head: { ref: "feature/x", sha: "h", repo: { full_name: "octo/repo" } },
        base: { ref: "main", sha: "b", repo: { full_name: "octo/repo" } },
      },
    });
    expect(parseEntityContext()!.pr).toMatchObject({ draft: false, isFork: false });

    // GitHub sends head.repo = null after the fork is deleted.
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "reopened",
      pull_request: {
        number: 45,
        head: { ref: "patch-1", sha: "h", repo: null },
        base: { ref: "main", sha: "b", repo: { full_name: "octo/repo" } },
      },
    });
    expect(parseEntityContext()!.pr?.isFork).toBe(true);
  });

  it("returns null for every event other than pull requests", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "created",
      comment: { body: "@pi review please" },
      issue: { number: 99, title: "PR title", body: "", pull_request: { url: "..." } },
    });
    for (const event of ["push", "issues", "issue_comment", "pull_request_review", "pull_request_review_comment"]) {
      process.env.GITHUB_EVENT_NAME = event;
      expect(parseEntityContext()).toBeNull();
    }
  });

  it("treats pull_request_target like pull_request", () => {
    process.env.GITHUB_EVENT_NAME = "pull_request_target";
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "synchronize",
      pull_request: { number: 8, head: { ref: "h", sha: "s" }, base: { ref: "main", sha: "b" } },
    });
    expect(parseEntityContext()).toMatchObject({ eventAction: "synchronize", entityNumber: 8 });
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
  it("defaults to the repository config file path", () => {
    delete process.env.INPUT_CONFIG_PATH;
    expect(parseInputs().configPath).toBe(".elek.yml");
  });

  it("uses no run timeout unless one is explicit", () => {
    delete process.env.INPUT_RUN_TIMEOUT_SECONDS;
    expect(parseInputs().runTimeoutSeconds).toBeUndefined();

    for (const value of ["-10", "1.5", "abc"]) {
      process.env.INPUT_RUN_TIMEOUT_SECONDS = value;
      expect(parseInputs().runTimeoutSeconds).toBeUndefined();
    }

    process.env.INPUT_RUN_TIMEOUT_SECONDS = "120";
    expect(parseInputs().runTimeoutSeconds).toBe(120);

    for (const value of ["0", "off", "none", "false", "disabled"]) {
      process.env.INPUT_RUN_TIMEOUT_SECONDS = value;
      expect(parseInputs().runTimeoutSeconds).toBeUndefined();
    }
  });

  it("parses severity_threshold when explicitly set", () => {
    process.env.INPUT_SEVERITY_THRESHOLD = "IMPORTANT";

    expect(parseInputs().severityThreshold).toBe("important");
  });

  it("normalizes boolean-like action inputs", () => {
    delete process.env.INPUT_STICKY_COMMENT;
    expect(parseInputs().stickyComment).toBe(true);

    for (const value of ["0", "OFF", "false", "no"]) {
      process.env.INPUT_STICKY_COMMENT = value;
      expect(parseInputs().stickyComment).toBe(false);
    }
  });
});
