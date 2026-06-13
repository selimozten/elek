/**
 * Mode → tool allowlist + MCP wiring + edit permission.
 *
 * - review (default): the model can only read code and post review feedback
 *   through the MCP server. No bash, no write, no edit. The model literally
 *   has no tool that can approve, merge, or close anything.
 * - review+edit: also allows write/edit so the model can push fixes to its
 *   own elek/* branch. Still no bash (no shelling out to gh).
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
        // `mcp` is the proxy tool exposed by pi-mcp-adapter — without it
        // in the allowlist, the model has no way to reach our MCP server.
        piTools: "read,write,edit,grep,find,ls,mcp",
        useMcpServer: true,
        allowEdit: true,
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
