/**
 * Mode → tool allowlist and edit permission.
 *
 * - review (default): native repo-scoped read/search tools.
 * - review+edit: currently resolves to the same read-only review surface.
 *   Editing stays disabled until mutation tools can be sandboxed away from git
 *   auth, HOME, /proc, and other host secrets.
 * - agent: legacy behavior with the full tool surface.
 *
 * Unknown values fall back to review — safest default.
 */
export type Mode = "review" | "review+edit" | "agent";

export interface ResolvedMode {
  mode: Mode;
  piTools: string;
  allowEdit: boolean;
}

export function resolveMode(raw: string | undefined): ResolvedMode {
  switch (raw) {
    case "agent":
      return {
        mode: "agent",
        piTools: "read,write,edit,bash,grep,find,ls",
        allowEdit: true,
      };
    case "review+edit":
      return {
        mode: "review+edit",
        // Keep mutation tools disabled until write/edit are sandboxed.
        piTools: "read,grep,find,ls",
        allowEdit: false,
      };
    case "review":
    default:
      return {
        mode: "review",
        piTools: "read,grep,find,ls",
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
