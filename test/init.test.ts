import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  helpText,
  parseArgs,
  planFiles,
  renderConfig,
  renderWorkflow,
  writePlannedFiles,
} from "../bin/elek-init.mjs";

describe("elek-init", () => {
  it("uses low-friction defaults for a first review workflow", () => {
    const options = parseArgs(["--provider=deepseek"]);

    expect(options.provider).toBe("deepseek");
    expect(options.model).toBe("deepseek-v4-pro");
    expect(options.secret).toBe("DEEPSEEK_API_KEY");
    expect(options.thinking).toBe("high");
    expect(options.strategy).toBe("solo");
    expect(options.writeConfig).toBe(true);
  });

  it("uses Together defaults suitable for cheap max-thinking reviewers", () => {
    const options = parseArgs(["--provider=together", "--strategy=thermos"]);

    expect(options.provider).toBe("together");
    expect(options.model).toBe("moonshotai/Kimi-K2.7-Code");
    expect(options.secret).toBe("TOGETHER_API_KEY");
    expect(options.thinking).toBe("max");
    expect(options.strategy).toBe("thermos");
  });

  it("renders a safe review-only workflow", () => {
    const workflow = renderWorkflow(parseArgs([
      "--provider",
      "openrouter",
      "--model",
      "moonshotai/kimi-k2.7-code",
      "--secret",
      "OPENROUTER_API_KEY",
      "--thinking",
      "xhigh",
      "--action-ref",
      "owner/elek@v2",
    ]));

    expect(workflow).toContain("pull_request: { types: [opened, synchronize, reopened] }");
    expect(workflow).toContain("issues: { types: [opened] }");
    expect(workflow).toContain("issue_comment: { types: [created] }");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain("name: Checkout repository");
    expect(workflow).toContain("actions/checkout@v6.0.3");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("name: Run elek review");
    expect(workflow).toContain("openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}");
    expect(workflow).toContain("provider: openrouter");
    expect(workflow).toContain("model: moonshotai/kimi-k2.7-code");
    expect(workflow).toContain("thinking: xhigh");
    expect(workflow).toContain("uses: owner/elek@v2");
    expect(workflow).toContain("config_path: .elek.yml");
    expect(workflow).not.toContain("contents: write");
  });

  it("uses the configured repo config path in the workflow", () => {
    const workflow = renderWorkflow(parseArgs(["--config-path", ".github/elek.yml"]));

    expect(workflow).toContain("config_path: .github/elek.yml");
    expect(planFiles(parseArgs(["--config-path", ".github/elek.yml"])).map((file) => file.path)).toEqual([
      ".github/workflows/elek.yml",
      ".github/elek.yml",
    ]);
  });

  it("renders repo config for strategy and budget policy", () => {
    const config = renderConfig(parseArgs([
      "--strategy",
      "crosscheck",
      "--max-cost-usd",
      "0.05",
    ]));

    expect(config).toContain("review_strategy: crosscheck");
    expect(config).toContain("max_cost_usd: 0.05");
    expect(config).toContain("severity_threshold: important");
    expect(config).toContain("knowledge_paths:");
    expect(config).toContain("AGENTS.md");
    expect(config).toContain("CONTRIBUTING.md");
    expect(config).toContain("ignore_paths:");
    expect(config).toContain("instructions:");
    expect(config).toContain("security-sensitive behavior changes");
  });

  it("can write only the workflow when config is disabled", () => {
    const options = parseArgs(["--no-config", "true", "--config=false"]);
    const files = planFiles(options);

    expect(files.map((file) => file.path)).toEqual([".github/workflows/elek.yml"]);
    expect(renderWorkflow(options)).not.toContain("config_path:");
  });

  it("rejects workflow and config path collisions", () => {
    expect(() => planFiles(parseArgs(["--workflow", ".elek.yml", "--config-path", ".elek.yml"]))).toThrow(
      "must be different files",
    );
  });

  it("writes planned files and refuses to overwrite without --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-init-test-"));
    try {
      const options = parseArgs([
        "--strategy",
        "crosscheck",
        "--max-cost-usd",
        "0.10",
        "--workflow",
        ".github/workflows/review.yml",
      ]);
      const written = writePlannedFiles(options, dir);

      expect(written).toEqual([".github/workflows/review.yml", ".elek.yml"]);
      expect(existsSync(join(dir, ".github/workflows/review.yml"))).toBe(true);
      expect(readFileSync(join(dir, ".elek.yml"), "utf8")).toContain("max_cost_usd: 0.10");
      expect(() => writePlannedFiles(options, dir)).toThrow("already exists");
      expect(writePlannedFiles({ ...options, force: true }, dir)).toEqual([
        ".github/workflows/review.yml",
        ".elek.yml",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported choices before writing files", () => {
    expect(() => parseArgs(["--provider", "unknown"])).toThrow("Unsupported provider");
    expect(() => parseArgs(["--strategy", "many"])).toThrow("Unsupported strategy");
    expect(() => parseArgs(["--max-cost-usd", "0"])).toThrow("positive number");
    expect(() => parseArgs(["--secret", "MY-SECRET"])).toThrow("valid GitHub Actions secret name");
    expect(() => parseArgs(["--secret", "GITHUB_TOKEN"])).toThrow("valid GitHub Actions secret name");
    expect(parseArgs(["--thinking", "max"]).thinking).toBe("max");
    expect(() => parseArgs(["--thinking", "ultra"])).toThrow("off, minimal, low, medium, high, xhigh, max");
    expect(() => parseArgs(["--action-ref", "owner/elek@v1\nbad"])).toThrow("non-empty action reference");
  });

  it("rejects output paths outside the repository", () => {
    expect(() => parseArgs(["--workflow", "../elek.yml"])).toThrow("inside the repository root");
    expect(() => parseArgs(["--config-path", ".github/../elek.yml"])).toThrow("inside the repository root");
    expect(() => parseArgs(["--workflow", "/tmp/elek.yml"])).toThrow("relative to the repository root");
    expect(() => parseArgs(["--config-path", "bad\npath.yml"])).toThrow("control characters");
    expect(() => parseArgs(["--workflow", " .github/workflows/elek.yml"])).toThrow("leading or trailing whitespace");
  });

  it("documents config file controls", () => {
    expect(helpText()).toContain("--config");
    expect(helpText()).toContain("--no-config");
    expect(helpText()).toContain("--thinking");
    expect(helpText()).toContain("--help, -h");
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });
});
