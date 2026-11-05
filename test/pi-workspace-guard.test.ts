import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import registerWorkspaceGuard, { assertWorkspacePath, filterToolText, readPathCandidates } from "../src/pi-workspace-guard";

describe("pi native tool workspace guard", () => {
  it("allows repository files and blocks sensitive or escaping paths", () => {
    const root = mkdtempSync(join(process.cwd(), ".elek-workspace-guard-"));
    const outside = mkdtempSync(join(process.cwd(), ".elek-workspace-outside-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, "src.ts"), "export const value = 1;\n");
      writeFileSync(join(root, ".env"), "SECRET=value\n");
      writeFileSync(join(root, ".git", "config"), "credential=value\n");
      writeFileSync(join(outside, "secret.txt"), "outside\n");
      symlinkSync(join(outside, "secret.txt"), join(root, "linked.txt"));

      expect(assertWorkspacePath("src.ts", root)).toBe(join(root, "src.ts"));
      expect(() => assertWorkspacePath(".env", root)).toThrow("Access denied");
      expect(() => assertWorkspacePath(".git/config", root)).toThrow("Access denied");
      expect(() => assertWorkspacePath("../secret.txt", root)).toThrow("outside the repository workspace");
      expect(() => assertWorkspacePath("linked.txt", root)).toThrow("Access denied");
      expect(() => assertWorkspacePath("/proc/self/environ", root)).toThrow("outside the repository workspace");
      // Pi expands these before opening them, so the guard must as well.
      expect(() => assertWorkspacePath("~", root)).toThrow("outside the repository workspace");
      expect(() => assertWorkspacePath("~/.aws/credentials", root)).toThrow("outside the repository workspace");
      expect(() => assertWorkspacePath("@~/.git-credentials", root)).toThrow("outside the repository workspace");
      expect(() => assertWorkspacePath("file:///etc/passwd", root)).toThrow("outside the repository workspace");
      expect(() => assertWorkspacePath(`file://${join(root, ".env")}`, root)).toThrow("Access denied");
      expect(() => assertWorkspacePath(".\u00A0env", root)).not.toThrow();
      expect(assertWorkspacePath(`file://${join(root, "src.ts")}`, root)).toBe(join(root, "src.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blocks unsafe native Pi tool calls before execution", () => {
    let handler: ((event: { toolName: string; input: { path?: string } }) => unknown) | undefined;
    registerWorkspaceGuard({
      on: (name: string, value: typeof handler) => {
        if (name === "tool_call") handler = value;
      },
    } as never);

    expect(handler?.({ toolName: "read", input: { path: ".git/config" } })).toMatchObject({
      block: true,
    });
    expect(handler?.({ toolName: "read", input: { path: "src/pi.ts" } })).toBeUndefined();
  });

  it("refuses a read whose fallback spelling Pi would open is protected", () => {
    const root = mkdtempSync(join(process.cwd(), ".elek-guard-variants-"));
    const outside = mkdtempSync(join(process.cwd(), ".elek-guard-variants-out-"));
    let handler: ((event: { toolName: string; input: { path?: string } }) => unknown) | undefined;
    const previous = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = root;
    try {
      registerWorkspaceGuard({
        on: (name: string, value: typeof handler) => {
          if (name === "tool_call") handler = value;
        },
      } as never);
      writeFileSync(join(outside, "passwd"), "x\n");
      // A symlink named with a curly apostrophe; the model asks for the
      // straight one, which does not exist, so Pi falls back to this link.
      symlinkSync(join(outside, "passwd"), join(root, "it\u2019s.txt"));
      expect(handler?.({ toolName: "read", input: { path: "it's.txt" } })).toMatchObject({ block: true });
      // The Kelvin sign escapes /token/i, but its NFD form is a plain K.
      expect(handler?.({ toolName: "read", input: { path: "api-to\u212Aen.json" } })).toMatchObject({ block: true });
      expect(handler?.({ toolName: "read", input: { path: "notes.txt" } })).toBeUndefined();
      expect(readPathCandidates("shot 10.00 PM.png", root)).toContain(join(root, "shot 10.00\u202FPM.png"));
    } finally {
      if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
      else process.env.GITHUB_WORKSPACE = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  describe("recursive tool results", () => {
    const setup = () => {
      const root = mkdtempSync(join(process.cwd(), ".elek-guard-results-"));
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, ".git", "config"), "x\n");
      writeFileSync(join(root, ".env"), "x\n");
      writeFileSync(join(root, "src", "a.ts"), "x\n");
      writeFileSync(join(root, "src", "api-token.json"), "x\n");
      return root;
    };

    it("withholds grep matches and context lines in protected files, keeping notices", () => {
      const root = setup();
      try {
        const text = [
          ".git/config:3: \textraheader = AUTHORIZATION: basic abc",
          ".env:1: TOKEN=abc",
          "src/a.ts:1: const TOKEN = 1;",
          "src/a.ts-2- // context",
          "src/api-token.json:1: {}",
          "",
          "[100 matches limit reached. Use limit=200 for more, or refine pattern]",
        ].join("\n");
        const result = filterToolText("grep", ".", text, root);
        expect(result.withheld).toBe(3);
        expect(result.text).toBe([
          "src/a.ts:1: const TOKEN = 1;",
          "src/a.ts-2- // context",
          "",
          "[100 matches limit reached. Use limit=200 for more, or refine pattern]",
        ].join("\n"));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("withholds a line when any delimiter split names a protected file", () => {
      const root = setup();
      try {
        // Filenames may contain grep's delimiters; parsing only the first
        // split would read `safe` and keep the secret line.
        const text = [
          "safe:1: api-token.json:2: KEY=secret",
          "safe-7- api-token.json-2- KEY=secret",
          "src/a.ts:1: const ok = 1;",
        ].join("\n");
        expect(filterToolText("grep", ".", text, root)).toEqual({ text: "src/a.ts:1: const ok = 1;", withheld: 2 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("checks bracketed names like any other path, keeping Pi's notices", () => {
      const root = setup();
      try {
        const listing = ["[api-token].json", "[dir]/.env", "src/a.ts", "", "[500 results limit reached. Use limit=1000 for more, or refine pattern]"].join("\n");
        expect(filterToolText("find", ".", listing, root)).toEqual({
          text: ["src/a.ts", "", "[500 results limit reached. Use limit=1000 for more, or refine pattern]"].join("\n"),
          withheld: 2,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("withholds look-alike and nested protected names in results", () => {
      const root = setup();
      try {
        mkdirSync(join(root, ".env.d"));
        writeFileSync(join(root, ".env.d", "prod"), "x\n");
        const text = ["api-to\u212Aen.json:1: SECRET", ".env.d/prod:1: KEY=x", "src/a.ts:1: ok"].join("\n");
        expect(filterToolText("grep", ".", text, root)).toEqual({ text: "src/a.ts:1: ok", withheld: 2 });
        expect(() => assertWorkspacePath(".env.d/prod", root)).toThrow("Access denied");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("withholds every path line when the workspace cannot be resolved", () => {
      expect(filterToolText("find", ".", "src/a.ts\n[1 more]\n", join(tmpdir(), "elek-gone-workspace"))).toEqual({
        text: "",
        withheld: 2,
      });
    });

    it("withholds all grep output that is not well formed", () => {
      const root = setup();
      try {
        // A protected file named `.env.d/prod<newline>safe` prints as two lines.
        const text = ".env.d/prod\nsafe:1: SECRET\nsrc/a.ts:1: ok";
        expect(filterToolText("grep", ".", text, root).text).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("judges Windows paths the way Pi resolves them there", () => {
      const root = setup();
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        expect(() => assertWorkspacePath("/c/Users/me/.ssh/id_rsa", root)).toThrow("outside the repository workspace");
        expect(() => assertWorkspacePath("/mnt/c/x", root)).toThrow("outside the repository workspace");
        expect(() => assertWorkspacePath("~\\.ssh\\id_rsa", root)).toThrow("outside the repository workspace");
        expect(() => assertWorkspacePath(".git.", root)).toThrow("Access denied");
        expect(() => assertWorkspacePath(".env::$DATA", root)).toThrow("Access denied");
      } finally {
        Object.defineProperty(process, "platform", platform);
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("resolves result lines against the searched directory", () => {
      const root = setup();
      try {
        expect(filterToolText("grep", "src", "api-token.json:1: {}\na.ts:1: x", root)).toEqual({ text: "a.ts:1: x", withheld: 1 });
        // A single-file search prints basenames; they belong to that file.
        expect(filterToolText("grep", "src/a.ts", "a.ts:1: x\na.ts-2- y", root)).toEqual({ text: "a.ts:1: x\na.ts-2- y", withheld: 0 });
        expect(filterToolText("find", undefined, ".git/config\nsrc/a.ts\n.env", root)).toEqual({ text: "src/a.ts", withheld: 2 });
        expect(filterToolText("ls", ".", ".env\n.git/\nsrc/\n(empty directory)", root)).toEqual({ text: "src/\n(empty directory)", withheld: 2 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("rewrites only grep, find and ls results, and only when something is withheld", () => {
      const root = setup();
      const previous = process.env.GITHUB_WORKSPACE;
      process.env.GITHUB_WORKSPACE = root;
      try {
        let onResult: ((event: unknown) => unknown) | undefined;
        registerWorkspaceGuard({
          on: (name: string, value: (event: unknown) => unknown) => {
            if (name === "tool_result") onResult = value;
          },
        } as never);
        const event = (toolName: string, text: string) => ({
          toolName, input: { path: "." }, content: [{ type: "text", text }],
        });
        expect(onResult?.(event("grep", "src/a.ts:1: x"))).toBeUndefined();
        expect(onResult?.(event("read", ".git/config:1: x"))).toBeUndefined();
        // Silent: no count or notice that would tell the model a protected
        // file matched.
        expect(onResult?.(event("find", ".git/config\nsrc/a.ts"))).toEqual({
          content: [{ type: "text", text: "src/a.ts" }],
        });
        // Nothing left reads exactly like Pi's own empty result, and a limit
        // notice that counted the withheld matches is dropped.
        expect(onResult?.(event("grep", ".env:1: TOKEN=a\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]"))).toEqual({
          content: [{ type: "text", text: "No matches found" }],
        });
        expect(onResult?.(event("find", ".env"))).toEqual({ content: [{ type: "text", text: "No files found matching pattern" }] });
        expect(onResult?.(event("ls", ".git/\n.env"))).toEqual({ content: [{ type: "text", text: "(empty directory)" }] });
      } finally {
        if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
        else process.env.GITHUB_WORKSPACE = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
