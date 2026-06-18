import { describe, expect, it } from "bun:test";
import { formatChangedFilesForPrompt, parseUnifiedDiffFiles } from "../src/review/diff-context";

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
});
