import { describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { getGitDiff, isSafeGitRefName } from "../src/github/git";

describe("isSafeGitRefName", () => {
  it("allows ordinary GitHub branch refs", () => {
    expect(isSafeGitRefName("main")).toBe(true);
    expect(isSafeGitRefName("feature/payments-hardening")).toBe(true);
    expect(isSafeGitRefName("refs/pull/123/head")).toBe(true);
    expect(isSafeGitRefName("release/v1.2.3")).toBe(true);
  });

  it("rejects shell metacharacters and unsafe ref syntax", () => {
    expect(isSafeGitRefName("feature/$(touch${IFS}/tmp/elek-pwned)")).toBe(false);
    expect(isSafeGitRefName("feature/`touch /tmp/elek-pwned`")).toBe(false);
    expect(isSafeGitRefName("feature/ok;touch-pwned")).toBe(false);
    expect(isSafeGitRefName("-upload-pack=touch-pwned")).toBe(false);
    expect(isSafeGitRefName("feature/../../main")).toBe(false);
    expect(isSafeGitRefName("feature/@{upstream}")).toBe(false);
  });

  it("rejects malicious diff refs before invoking git", () => {
    expect(() => getGitDiff("main", "feature/$(touch${IFS}/tmp/elek-pwned)")).toThrow("Unsafe head ref");
  });

  it("uses checked-out refs before attempting an authenticated fetch", () => {
    const dir = mkdtempSync(join(tmpdir(), "elek-git-local-diff-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe" });

    try {
      git("init", "-b", "main");
      git("config", "user.name", "Elek Test");
      git("config", "user.email", "elek@example.test");
      writeFileSync(join(dir, "reviewed.txt"), "base\n", "utf-8");
      git("add", "reviewed.txt");
      git("commit", "-m", "base");
      const baseSha = git("rev-parse", "HEAD").toString().trim();
      git("update-ref", "refs/remotes/origin/main", baseSha);
      git("checkout", "-b", "feature/review");
      writeFileSync(join(dir, "reviewed.txt"), "base\nhead\n", "utf-8");
      git("add", "reviewed.txt");
      git("commit", "-m", "head");
      git("remote", "add", "origin", "https://invalid.invalid/repo.git");

      const modulePath = resolve(import.meta.dir, "../src/github/git.ts");
      const script = [
        `import { getGitDiff } from ${JSON.stringify(modulePath)};`,
        `process.stdout.write(getGitDiff("main", "main"));`,
      ].join("\n");
      const diff = execFileSync(process.execPath, ["-e", script], {
        cwd: dir,
        encoding: "utf-8",
        stdio: "pipe",
      });

      expect(diff).toContain("+head");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
