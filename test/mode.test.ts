/**
 * Tests for the mode → tools/permissions mapping.
 * Pure mapping; no side effects.
 */
import { describe, it, expect } from "bun:test";
import { resolveEffectivePiTools, resolveMode, resolvePiTools } from "../src/github/mode";

describe("resolveMode", () => {
  it("review (default) allows repo-scoped read/search plus the mcp proxy", () => {
    const m = resolveMode("review");
    expect(m.piTools.split(",").sort()).toEqual(["find", "grep", "ls", "mcp", "read"]);
    expect(m.useMcpServer).toBe(true);
    expect(m.allowEdit).toBe(false);
  });

  it("review+edit remains read-only until mutation tools are sandboxed", () => {
    const m = resolveMode("review+edit");
    expect(m.piTools.split(",").sort()).toEqual(["find", "grep", "ls", "mcp", "read"]);
    expect(m.piTools).not.toContain("write");
    expect(m.piTools).not.toContain("edit");
    expect(m.piTools).not.toContain("bash");
    expect(m.useMcpServer).toBe(true);
    expect(m.allowEdit).toBe(false);
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

describe("resolvePiTools", () => {
  it("ignores tools overrides in review mode", () => {
    const mode = resolveMode("review");
    expect(resolvePiTools(mode, "read,bash").split(",").sort()).toEqual(["find", "grep", "ls", "mcp", "read"]);
  });

  it("ignores tools overrides in review+edit mode", () => {
    const mode = resolveMode("review+edit");
    expect(resolvePiTools(mode, "read,bash").split(",").sort()).toEqual(["find", "grep", "ls", "mcp", "read"]);
  });

  it("allows tools overrides in legacy agent mode", () => {
    const mode = resolveMode("agent");
    expect(resolvePiTools(mode, " read,grep ")).toBe("read,grep");
  });

  it("uses the agent preset when no tools override is supplied", () => {
    const mode = resolveMode("agent");
    expect(resolvePiTools(mode, "")).toBe("read,write,edit,bash,grep,find,ls");
  });
});

describe("resolveEffectivePiTools", () => {
  it("keeps mcp when MCP is enabled", () => {
    const mode = resolveMode("review");
    expect(resolveEffectivePiTools(mode, "", { mcpEnabled: true })).toBe("read,grep,find,ls,mcp");
  });

  it("filters mcp when MCP is force-disabled", () => {
    const mode = resolveMode("review+edit");
    expect(resolveEffectivePiTools(mode, "", { mcpEnabled: false }).split(",").sort()).toEqual([
      "find",
      "grep",
      "ls",
      "read",
    ]);
  });

  it("preserves legacy agent tool overrides when MCP is disabled", () => {
    const mode = resolveMode("agent");
    expect(resolveEffectivePiTools(mode, "read,bash", { mcpEnabled: false })).toBe(
      "read,bash",
    );
  });
});
