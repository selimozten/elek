/**
 * Tests for the provider credential preflight that runs before any GitHub
 * writes.
 */
import { describe, expect, it } from "bun:test";
import { credentialPreflight } from "../src/credentials";

describe("credentialPreflight", () => {
  it("continues when the provider key is present", () => {
    expect(credentialPreflight({
      provider: "deepseek",
      env: { DEEPSEEK_API_KEY: "sk-test" },
      rawEventName: "pull_request",
      isForkPR: true,
    })).toEqual({ action: "continue" });
  });

  it("accepts either Google key variable", () => {
    expect(credentialPreflight({
      provider: "google",
      env: { GEMINI_API_KEY: "", GOOGLE_API_KEY: "g" },
      rawEventName: "pull_request",
      isForkPR: false,
    })).toEqual({ action: "continue" });
  });

  it("skips fork pull_request runs where GitHub withheld secrets", () => {
    for (const rawEventName of ["pull_request", "pull_request_review", "pull_request_review_comment"]) {
      const result = credentialPreflight({
        provider: "deepseek",
        env: { DEEPSEEK_API_KEY: "" },
        rawEventName,
        isForkPR: true,
      });
      expect(result.action).toBe("skip");
      if (result.action === "skip") {
        expect(result.message).toContain("fork");
      }
    }
  });

  it("fails loudly with the input to set when a same-repo run has no key", () => {
    const result = credentialPreflight({
      provider: "opencode-go",
      env: { OPENCODE_API_KEY: "  " },
      rawEventName: "pull_request",
      isForkPR: false,
    });
    expect(result.action).toBe("fail");
    if (result.action === "fail") {
      expect(result.message).toContain("OPENCODE_API_KEY");
      expect(result.message).toContain("opencode_api_key: ${{ secrets.OPENCODE_API_KEY }}");
    }
  });

  it("fails rather than skips for fork events that run with base-repo secrets", () => {
    for (const rawEventName of ["pull_request_target", "issue_comment"]) {
      expect(credentialPreflight({
        provider: "anthropic",
        env: {},
        rawEventName,
        isForkPR: true,
      }).action).toBe("fail");
    }
  });

  it("leaves providers Elek cannot inspect to Pi on same-repo runs", () => {
    for (const provider of ["amazon-bedrock", "constructor", "__proto__", "toString"]) {
      expect(credentialPreflight({
        provider,
        env: {},
        rawEventName: "pull_request",
        isForkPR: false,
      })).toEqual({ action: "continue" });
    }
  });

  it("skips fork pull_request runs for providers it cannot inspect", () => {
    expect(credentialPreflight({
      provider: "amazon-bedrock",
      env: {},
      rawEventName: "pull_request",
      isForkPR: true,
    }).action).toBe("skip");
  });
});
