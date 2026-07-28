import { describe, expect, it } from "bun:test";
import {
  diffPromptBudgetChars,
  formatChangedFilesForPrompt,
  modelInputBudgetChars,
  parseUnifiedDiffFiles,
} from "../src/review/diff-context";

describe("diff prompt context", () => {
  it("parses changed files and line counts from unified diffs", () => {
    const diff = [
      "diff --git a/src/a.go b/src/a.go",
      "--- a/src/a.go",
      "+++ b/src/a.go",
      "@@ -1,2 +1,3 @@",
      " package main",
      "-old()",
      "+new()",
      "+extra()",
      "diff --git a/README.md b/README.md",
      "deleted file mode 100644",
      "--- a/README.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-docs",
    ].join("\n");
    const files = parseUnifiedDiffFiles(diff);

    expect(files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }))).toEqual([
      { path: "src/a.go", status: "modified", additions: 2, deletions: 1 },
      { path: "README.md", status: "deleted", additions: 0, deletions: 1 },
    ]);
    expect(formatChangedFilesForPrompt(diff, 10_000)).toContain("# Changed file overview (2 files");
    expect(formatChangedFilesForPrompt(diff, 10_000)).toContain("# Full diff");
  });

  it("keeps later application files visible when early docs deletions are huge", () => {
    const hugeReadmeDeletion = Array.from({ length: 3_000 }, (_, i) => `-deleted docs ${i}`).join("\n");
    const diff = [
      "diff --git a/README.md b/README.md",
      "deleted file mode 100644",
      "--- a/README.md",
      "+++ /dev/null",
      "@@ -1,3000 +0,0 @@",
      hugeReadmeDeletion,
      "diff --git a/src/server.go b/src/server.go",
      "--- a/src/server.go",
      "+++ b/src/server.go",
      "@@ -10,2 +10,3 @@",
      " func serve() error {",
      "+  return validateTenant()",
      " }",
    ].join("\n");

    const out = formatChangedFilesForPrompt(diff, 5_000);

    expect(out).toContain("# Changed file overview (2 files");
    expect(out).toContain("# - README.md (deleted");
    expect(out).toContain("# - src/server.go (modified");
    expect(out).toContain("diff --git a/src/server.go b/src/server.go");
    expect(out).toContain("+  return validateTenant()");
    expect(out).toContain("diff truncated by file for prompt budget");
  });

  it("keeps the full diff whenever it fits the selected model budget", () => {
    const largeGeneratedFile = Array.from({ length: 9_000 }, (_, i) => `+generated line ${i}`).join("\n");
    const diff = [
      "diff --git a/docs/generated.md b/docs/generated.md",
      "--- a/docs/generated.md",
      "+++ b/docs/generated.md",
      "@@ -1 +1,9000 @@",
      largeGeneratedFile,
      "diff --git a/src/auth/server.go b/src/auth/server.go",
      "--- a/src/auth/server.go",
      "+++ b/src/auth/server.go",
      "@@ -10,2 +10,4 @@",
      " func lookup() {",
      "+  query := db.User.First()",
      "+  _ = query",
      " }",
    ].join("\n");

    const out = formatChangedFilesForPrompt(diff, 200_000);

    expect(diff.length).toBeLessThan(200_000);
    expect(out).toContain("# Changed file overview (2 files");
    expect(out).toContain("# Full diff");
    expect(out).not.toContain("# Representative diff slices");
    expect(out).toContain("diff --git a/src/auth/server.go b/src/auth/server.go");
    expect(out).toContain("+  query := db.User.First()");
    expect(out).toContain("+generated line 8999");
  });

  it("uses model-aware input budgets with only an explicit reserve", () => {
    expect(modelInputBudgetChars("together/zai-org/GLM-5.2")).toBe(540_000);
    expect(modelInputBudgetChars("openai/gpt-5.6-sol")).toBe(700_000);
    expect(modelInputBudgetChars("together/moonshotai/Kimi-K3")).toBe(2_700_000);
    expect(diffPromptBudgetChars("together/zai-org/GLM-5.2", 40_000)).toBe(500_000);
    expect(diffPromptBudgetChars("unknown/model", 20_000)).toBe(300_000);
  });
});
