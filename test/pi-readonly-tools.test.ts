import { describe, expect, it } from "bun:test";
import { resolve } from "path";
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
});
