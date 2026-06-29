import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { assertWorkspacePath } from "../src/pi-readonly-tools";

describe("pi read-only workspace tools", () => {
  it("allows normal repository files", () => {
    expect(assertWorkspacePath(resolve(process.cwd(), "src/pi.ts"))).toBe(resolve(process.cwd(), "src/pi.ts"));
  });

  it("blocks git metadata, env files, and paths outside the workspace", () => {
    expect(() => assertWorkspacePath(resolve(process.cwd(), ".git/config"))).toThrow("Access denied");
    expect(() => assertWorkspacePath(resolve(process.cwd(), ".env.production"))).toThrow("Access denied");
    expect(() => assertWorkspacePath(resolve(process.cwd(), "..", "outside.txt"))).toThrow("Access denied");
  });

  it("rejects symlinks before read tools can follow them outside the workspace", () => {
    const outside = mkdtempSync(join(process.cwd(), ".elek-outside-"));
    const inside = mkdtempSync(join(process.cwd(), ".elek-inside-"));
    try {
      const target = join(outside, "secret.txt");
      const link = join(inside, "notes.md");
      writeFileSync(target, "secret");
      symlinkSync(target, link);

      expect(() => assertWorkspacePath(link)).toThrow("Access denied");
    } finally {
      rmSync(inside, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
