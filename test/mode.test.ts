/**
 * Tests for the mode → tools/permissions mapping.
 * Pure mapping; no side effects.
 */
import { describe, it, expect } from "bun:test";
import { resolveMode } from "../src/github/mode";

describe("resolveMode", () => {
  it("review (default) restricts pi tools to read-only + the mcp proxy", () => {
    const m = resolveMode("review");
    expect(m.piTools.split(",").sort()).toEqual(["find", "grep", "ls", "mcp", "read"]);
    expect(m.useMcpServer).toBe(true);
    expect(m.allowEdit).toBe(false);
  });

  it("review+edit adds write/edit tools and keeps the mcp proxy", () => {
    const m = resolveMode("review+edit");
    expect(m.piTools).toContain("read");
    expect(m.piTools).toContain("write");
    expect(m.piTools).toContain("edit");
    expect(m.piTools).toContain("mcp");
    expect(m.piTools).not.toContain("bash");
    expect(m.useMcpServer).toBe(true);
    expect(m.allowEdit).toBe(true);
  });

  it("agent mode = legacy behavior: full tool surface, no MCP injection", () => {
    const m = resolveMode("agent");
    expect(m.piTools).toContain("bash");
    expect(m.useMcpServer).toBe(false);
    expect(m.allowEdit).toBe(true);
  });

  it("falls back to review for unknown values (safest default)", () => {
    const m = resolveMode("nonsense");
    expect(m.piTools.split(",").sort()).toEqual(["find", "grep", "ls", "mcp", "read"]);
    expect(m.useMcpServer).toBe(true);
  });
});
