import { describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createReviewWorkspace, removeReviewWorkspace } from "../src/review-workspace";
import { tmpdir } from "node:os";
import { join } from "node:path";

function gitIn(dir: string) {
  return (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, "-c", "protocol.file.allow=always", ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    expect(result.exitCode, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  };
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "elek-review-src-"));
  const git = gitIn(dir);
  git("init", "-q");
  mkdirSync(join(dir, "src", "tokenizer"), { recursive: true });
  mkdirSync(join(dir, "config", ".env.d"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "tokenizer", "index.ts"), "export {};\n");
  writeFileSync(join(dir, "src", "api-toKen.json"), "{}\n");
  writeFileSync(join(dir, "config", ".env.d", "prod"), "KEY=x\n");
  writeFileSync(join(dir, "credentials.yaml"), "k: v\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  writeFileSync(join(dir, ".env"), "UNTRACKED=1\n");
  writeFileSync(join(dir, "scratch.ts"), "untracked\n");
  return dir;
}

describe("createReviewWorkspace", () => {
  it("copies tracked files only and drops every protected name", () => {
    const source = repo();
    const temp = mkdtempSync(join(tmpdir(), "elek-review-tmp-"));
    try {
      const review = createReviewWorkspace(source, temp);
      expect(readFileSync(join(review, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(existsSync(join(review, "src", "tokenizer", "index.ts"))).toBe(true);
      for (const absent of [".git", ".env", "scratch.ts", "credentials.yaml", "config/.env.d", "src/api-toKen.json"]) {
        expect(existsSync(join(review, absent)), absent).toBe(false);
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("fails, leaving nothing behind, outside a git checkout", () => {
    const source = mkdtempSync(join(tmpdir(), "elek-review-nogit-"));
    const temp = mkdtempSync(join(tmpdir(), "elek-review-tmp-"));
    try {
      expect(() => createReviewWorkspace(source, temp)).toThrow();
      expect(readdirSync(temp)).toEqual([]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("copies the commit, not files an earlier step staged or a sparse checkout hid", () => {
    const source = repo();
    const temp = mkdtempSync(join(tmpdir(), "elek-review-tmp-"));
    const git = gitIn(source);
    try {
      writeFileSync(join(source, "src", "a.ts"), "staged later\n");
      writeFileSync(join(source, "staged.ts"), "new\n");
      git("add", "src/a.ts", "staged.ts");
      git("sparse-checkout", "set", "--no-cone", "/config/");
      const review = createReviewWorkspace(source, temp);
      expect(readFileSync(join(review, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(existsSync(join(review, "staged.ts"))).toBe(false);
      expect(existsSync(join(review, "src", "tokenizer", "index.ts"))).toBe(true);
      expect(readdirSync(temp)).toHaveLength(1);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("includes initialized submodules, minus their protected files", () => {
    const sub = mkdtempSync(join(tmpdir(), "elek-review-sub-"));
    const temp = mkdtempSync(join(tmpdir(), "elek-review-tmp-"));
    const source = repo();
    try {
      const subGit = gitIn(sub);
      subGit("init", "-q");
      writeFileSync(join(sub, "lib.ts"), "export const lib = 1;\n");
      writeFileSync(join(sub, "secret.env"), "x\n");
      subGit("add", ".");
      subGit("commit", "-q", "-m", "sub");
      const git = gitIn(source);
      git("submodule", "-q", "add", sub, "vendor/lib");
      git("commit", "-q", "-m", "add submodule");
      const review = createReviewWorkspace(source, temp);
      expect(readFileSync(join(review, "vendor", "lib", "lib.ts"), "utf8")).toBe("export const lib = 1;\n");
      expect(existsSync(join(review, "vendor", "lib", "secret.env"))).toBe(false);
      expect(existsSync(join(review, "vendor", "lib", ".git"))).toBe(false);

      // Advance the submodule's checkout past the recorded commit: the copy
      // still shows the commit the reviewed superproject records.
      writeFileSync(join(source, "vendor", "lib", "lib.ts"), "export const lib = 2;\n");
      gitIn(join(source, "vendor", "lib"))("commit", "-q", "-am", "advance");
      const again = createReviewWorkspace(source, temp);
      expect(readFileSync(join(again, "vendor", "lib", "lib.ts"), "utf8")).toBe("export const lib = 1;\n");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(sub, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("removes a workspace without ever throwing", () => {
    expect(() => removeReviewWorkspace(join(tmpdir(), "elek-review-missing", "x"))).not.toThrow();
  });

  it("writes committed bytes: no filters, replace refs, symlinks or oversized blobs", () => {
    const source = repo();
    const temp = mkdtempSync(join(tmpdir(), "elek-review-tmp-"));
    const git = gitIn(source);
    try {
      // A tracked .gitattributes selecting a filter that local config defines.
      writeFileSync(join(source, ".gitattributes"), "*.txt filter=evil\n");
      writeFileSync(join(source, "notes.txt"), "committed\n");
      symlinkSync("/etc/passwd", join(source, "link"));
      writeFileSync(join(source, "big.bin"), Buffer.alloc(9 * 1024 * 1024));
      git("add", ".gitattributes", "notes.txt", "link", "big.bin");
      git("commit", "-q", "-m", "hostile");
      git("config", "filter.evil.smudge", "echo PWNED");
      // A replace ref pointing HEAD's tree elsewhere must be ignored.
      writeFileSync(join(source, "notes.txt"), "replaced\n");
      git("commit", "-q", "-am", "replacement");
      const replacement = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"]).stdout.toString().trim();
      git("reset", "-q", "--hard", "HEAD~1");
      const head = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"]).stdout.toString().trim();
      git("replace", head, replacement);

      const review = createReviewWorkspace(source, temp);
      expect(readFileSync(join(review, "notes.txt"), "utf8")).toBe("committed\n");
      expect(existsSync(join(review, "big.bin"))).toBe(false);
      expect(() => lstatSync(join(review, "link"))).toThrow();
      expect(readFileSync(join(review, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("exports many large blobs in byte-bounded batches", () => {
    const source = repo();
    const temp = mkdtempSync(join(tmpdir(), "elek-review-tmp-"));
    const git = gitIn(source);
    try {
      // Ten files sharing one 8 MiB blob: 80 MiB of output from a tiny repo.
      const big = Buffer.alloc(8 * 1024 * 1024, 7);
      for (let i = 0; i < 10; i++) writeFileSync(join(source, `big-${i}.bin`), big);
      git("add", ".");
      git("commit", "-q", "-m", "big");
      const review = createReviewWorkspace(source, temp);
      for (let i = 0; i < 10; i++) expect(readFileSync(join(review, `big-${i}.bin`)).equals(big)).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("leaves out a path the filesystem cannot tell apart, without failing", () => {
    const temp = mkdtempSync(join(tmpdir(), "elek-review-tmp-"));
    writeFileSync(join(temp, "probe"), "");
    const caseInsensitive = existsSync(join(temp, "PROBE"));
    rmSync(join(temp, "probe"));
    if (!caseInsensitive) {
      rmSync(temp, { recursive: true, force: true });
      return; // Linux runners keep A and a apart; nothing collides.
    }
    const source = mkdtempSync(join(tmpdir(), "elek-review-case-"));
    const git = gitIn(source);
    try {
      git("init", "-q");
      // Build the tree directly: this filesystem cannot hold both checkouts.
      const blob = (text: string) => Bun.spawnSync(["git", "-C", source, "hash-object", "-w", "--stdin"], { stdin: Buffer.from(text) }).stdout.toString().trim();
      const upper = blob("UPPER\n");
      const lower = blob("lower\n");
      const tree = Bun.spawnSync(["git", "-C", source, "mktree"], {
        stdin: Buffer.from(`100644 blob ${upper}\tA\n100644 blob ${lower}\ta\n`),
      }).stdout.toString().trim();
      const commit = Bun.spawnSync(["git", "-C", source, "commit-tree", tree, "-m", "case"], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      }).stdout.toString().trim();
      git("update-ref", "HEAD", commit);
      const review = createReviewWorkspace(source, temp);
      // The first path keeps its own bytes; the alias is left out.
      expect(readdirSync(review)).toEqual(["A"]);
      expect(readFileSync(join(review, "A"), "utf8")).toBe("UPPER\n");

      // Directories: `A/first.ts` and `a/second.ts` share no file name, so
      // only the spelling check keeps them from merging into one folder.
      const mktree = (lines: string) => Bun.spawnSync(["git", "-C", source, "mktree"], { stdin: Buffer.from(lines) }).stdout.toString().trim();
      const upperDir = mktree(`100644 blob ${upper}\tfirst.ts\n`);
      const lowerDir = mktree(`100644 blob ${lower}\tsecond.ts\n`);
      const dirs = mktree(`040000 tree ${upperDir}\tA\n040000 tree ${lowerDir}\ta\n`);
      const dirCommit = Bun.spawnSync(["git", "-C", source, "commit-tree", dirs, "-m", "dirs"], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      }).stdout.toString().trim();
      git("update-ref", "HEAD", dirCommit);
      const merged = createReviewWorkspace(source, temp);
      expect(readdirSync(merged)).toEqual(["A"]);
      expect(readdirSync(join(merged, "A"))).toEqual(["first.ts"]);

      // Unicode case aliases: `STRASSE` and `Straße`, `Σ` and final `ς`.
      const unicodeDirs = mktree(`040000 tree ${upperDir}\tSTRASSE\n040000 tree ${lowerDir}\tStra\u00dfe\n040000 tree ${upperDir}\t\u03a3x\n040000 tree ${lowerDir}\t\u03c2x\n`);
      const unicodeCommit = Bun.spawnSync(["git", "-C", source, "commit-tree", unicodeDirs, "-m", "unicode"], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      }).stdout.toString().trim();
      git("update-ref", "HEAD", unicodeCommit);
      const folded = createReviewWorkspace(source, temp);
      for (const dir of readdirSync(folded)) {
        // Whatever the volume merges, no folder ends up with both children.
        expect(readdirSync(join(folded, dir)).length).toBe(1);
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("never fetches an excluded blob in a partial clone", () => {
    const origin = repo();
    const temp = mkdtempSync(join(tmpdir(), "elek-review-tmp-"));
    const clone = join(mkdtempSync(join(tmpdir(), "elek-review-partial-")), "clone");
    try {
      const originGit = gitIn(origin);
      writeFileSync(join(origin, "huge.bin"), Buffer.alloc(9 * 1024 * 1024, 1));
      originGit("add", "huge.bin");
      originGit("commit", "-q", "-m", "huge");
      originGit("config", "uploadpack.allowFilter", "true");
      const cloned = Bun.spawnSync(["git", "-c", "protocol.file.allow=always", "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${origin}`, clone]);
      expect(cloned.exitCode).toBe(0);
      const missing = () => Bun.spawnSync(["git", "-C", clone, "rev-list", "--objects", "--missing=print", "HEAD"]).stdout.toString();
      const blobOf = (path: string) => Bun.spawnSync(["git", "-C", clone, "rev-parse", `HEAD:${path}`]).stdout.toString().trim();
      const excluded = [blobOf("credentials.yaml"), blobOf("huge.bin")];
      for (const object of excluded) expect(missing()).toContain(`?${object}`);

      createReviewWorkspace(clone, temp);

      // Protected and oversized files are never asked for, so never fetched.
      for (const object of excluded) expect(missing()).toContain(`?${object}`);
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(join(clone, ".."), { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("exports only real git paths, and omits only true filesystem aliases", () => {
    // Names that some filesystems treat as one and others keep apart. The
    // copy must agree with whichever filesystem it is on, in both
    // directions, so this holds on Linux, macOS and Windows alike.
    const names = ["A", "a", "\u03a3x", "\u03c2x", "STRASSE", "Stra\u00dfe", "SS", "\u1e9e", "I", "\u0131", "\u00e9", "e\u0301", "\u00c5", "\u212b"];
    const source = mkdtempSync(join(tmpdir(), "elek-review-alias-"));
    const temp = mkdtempSync(join(tmpdir(), "elek-review-tmp-"));
    const git = gitIn(source);
    try {
      git("init", "-q");
      const run = (args: string[], input: string) => Bun.spawnSync(["git", "-C", source, ...args], {
        stdin: Buffer.from(input),
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      }).stdout.toString().trim();
      const lines = names.map((name, i) => {
        const blob = run(["hash-object", "-w", "--stdin"], `${i}\n`);
        const dir = run(["mktree"], `100644 blob ${blob}\tf${i}.ts\n`);
        return `040000 tree ${dir}\t${name}\n`;
      });
      const tree = run(["mktree"], lines.join(""));
      git("update-ref", "HEAD", run(["commit-tree", tree, "-m", "aliases"], ""));
      const tracked = names.map((name, i) => `${name}/f${i}.ts`);

      const review = createReviewWorkspace(source, temp);
      const exported: string[] = [];
      for (const dir of readdirSync(review)) for (const file of readdirSync(join(review, dir))) exported.push(`${dir}/${file}`);

      // 1. Nothing invented: every exported file is a git path, byte for byte.
      for (const path of exported) expect(tracked, path).toContain(path);
      for (const path of exported) {
        expect(readFileSync(join(review, path), "utf8")).toBe(`${tracked.indexOf(path)}\n`);
      }
      // 2. Nothing dropped without cause: an omitted path is one this
      // filesystem resolves to something already exported.
      for (const path of tracked.filter((p) => !exported.includes(p))) {
        expect(existsSync(join(review, path.split("/")[0])), path).toBe(true);
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
