import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import registerWorkspaceGuard, { assertWorkspacePath } from "../src/pi-workspace-guard";

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
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blocks unsafe native Pi tool calls before execution", () => {
    let handler: ((event: { toolName: string; input: { path?: string } }) => unknown) | undefined;
    registerWorkspaceGuard({
      on: (_name: string, value: typeof handler) => {
        handler = value;
      },
    } as never);

    expect(handler?.({ toolName: "read", input: { path: ".git/config" } })).toMatchObject({
      block: true,
    });
    expect(handler?.({ toolName: "read", input: { path: "src/pi.ts" } })).toBeUndefined();
  });
});
