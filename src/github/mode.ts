/**
 * Mode → tool allowlist + MCP wiring + edit permission.
 *
 * - review (default): repo-scoped read/search tools plus the MCP review
 *   server. No bash, write, or edit.
 * - review+edit: currently resolves to the same read-only review surface.
 *   Editing stays disabled until mutation tools can be sandboxed away from git
 *   auth, MCP token config, HOME, /proc, and other host secrets.
 * - agent: legacy behavior — full tool surface including bash. The MCP
 *   server is NOT injected (the host posts the tracking comment).
 *
 * Unknown values fall back to review — safest default.
 */
export type Mode = "review" | "review+edit" | "agent";

export interface ResolvedMode {
  mode: Mode;
  piTools: string;
  useMcpServer: boolean;
  allowEdit: boolean;
}

export function resolveMode(raw: string | undefined): ResolvedMode {
  switch (raw) {
    case "agent":
      return {
        mode: "agent",
        piTools: "read,write,edit,bash,grep,find,ls",
        useMcpServer: false,
        allowEdit: true,
      };
    case "review+edit":
      return {
        mode: "review+edit",
        // Keep mutation tools disabled until write/edit are sandboxed.
        piTools: "read,grep,find,ls,mcp",
        useMcpServer: true,
        allowEdit: false,
      };
    case "review":
    default:
      return {
        mode: "review",
        piTools: "read,grep,find,ls,mcp",
        useMcpServer: true,
        allowEdit: false,
      };
  }
}

export function resolvePiTools(
  resolvedMode: ResolvedMode,
  requestedTools: string | undefined,
): string {
  const trimmed = (requestedTools || "").trim();
  if (resolvedMode.mode === "agent" && trimmed) {
    return trimmed;
  }
  return resolvedMode.piTools;
}

export function resolveEffectivePiTools(
  resolvedMode: ResolvedMode,
  requestedTools: string | undefined,
  options: { mcpEnabled: boolean },
): string {
  const tools = resolvePiTools(resolvedMode, requestedTools);
  if (options.mcpEnabled) return tools;
  return tools
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool && tool !== "mcp")
    .join(",");
}
