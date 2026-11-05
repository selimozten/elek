/**
 * Tests for the provider credential preflight that runs before any GitHub
 * writes.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { __defaultModelProviders, credentialPreflight, missingModelProblem, providerKeyEnvVars } from "../src/credentials";

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
    const result = credentialPreflight({
      provider: "deepseek",
      env: { DEEPSEEK_API_KEY: "" },
      rawEventName: "pull_request",
      isForkPR: true,
    });
    expect(result.action).toBe("skip");
    if (result.action === "skip") {
      expect(result.message).toContain("fork");
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

  it("fails rather than skips for pull_request_target, which runs with base-repo secrets", () => {
    expect(credentialPreflight({
      provider: "anthropic",
      env: {},
      rawEventName: "pull_request_target",
      isForkPR: true,
    }).action).toBe("fail");
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

describe("missingModelProblem", () => {
  it("allows an empty model only for providers Pi can default alone", () => {
    expect(missingModelProblem("anthropic", "")).toBeUndefined();
    expect(missingModelProblem("deepseek", "")).toBeUndefined();
    // Pi resolves provider ids case-insensitively.
    expect(missingModelProblem(" Anthropic ", "")).toBeUndefined();
    expect(providerKeyEnvVars("Anthropic")).toEqual(["ANTHROPIC_API_KEY"]);
    expect(missingModelProblem("amazon-bedrock", "")).toContain("Set the `model` input");
    // opencode and opencode-go share a key, so Pi would pick across both.
    expect(missingModelProblem("opencode-go", "")).toContain("opencode-go");
    expect(missingModelProblem("opencode", "")).toContain("opencode");
    expect(missingModelProblem("opencode-go", "deepseek-v4.1-flash")).toBeUndefined();
    expect(missingModelProblem("amazon-bedrock", "anthropic.claude-haiku-5-5")).toBeUndefined();
  });

  it("matches the installed Pi: every allowed provider has a Pi default and a key of its own", async () => {
    // Pi does not export this table; read it from the installed package so a
    // Pi upgrade that drops a default fails here, not in a review.
    const resolver = await import(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js"));
    const piDefaults = resolver.defaultModelPerProvider as Record<string, string>;
    const mapped = [...__defaultModelProviders, "opencode", "opencode-go"];
    for (const provider of __defaultModelProviders) {
      expect(piDefaults[provider], `Pi has no default model for ${provider}`).toBeTruthy();
      const own = providerKeyEnvVars(provider) ?? [];
      expect(own.length).toBeGreaterThan(0);
      for (const other of mapped.filter((name) => name !== provider)) {
        const shared = (providerKeyEnvVars(other) ?? []).filter((v) => own.includes(v));
        expect(shared, `${provider} shares ${shared.join(", ")} with ${other}`).toEqual([]);
      }
    }
  });
});

describe("run entrypoint ordering", () => {
  it("rejects a missing model before the first GitHub write", async () => {
    // A failure after the tracking comment exists would leave it stale.
    const source = await Bun.file(join(process.cwd(), "src/entrypoints/run.ts")).text();
    const check = source.indexOf("missingModelProblem(inputs.provider, inputs.model)");
    const firstWrite = source.indexOf("await createTrackingComment(");
    expect(check).toBeGreaterThan(0);
    expect(firstWrite).toBeGreaterThan(0);
    expect(check).toBeLessThan(firstWrite);
    expect(source.indexOf("await updateTrackingComment(")).toBeGreaterThan(check);
  });
});

describe("credentialPreflight provider case", () => {
  it("checks a mixed-case provider's key before any GitHub write", () => {
    const base = { rawEventName: "pull_request", isForkPR: false };
    expect(credentialPreflight({ ...base, provider: "Anthropic", env: {} }).action).toBe("fail");
    expect(credentialPreflight({ ...base, provider: "Anthropic", env: { ANTHROPIC_API_KEY: "k" } }).action).toBe("continue");
  });
});
