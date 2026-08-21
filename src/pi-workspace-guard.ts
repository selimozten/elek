import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const guardedTools = new Set(["read", "grep", "find", "ls"]);
const blockedBasename = /^(?:\.env(?:\..*)?|.*(?:secret|credential|private[-_]?key|token).*\.(?:json|ya?ml|toml|txt|env|pem|key))$/i;

function isOutside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function denied(path: string, root: string, reason: string): Error {
  const display = relative(root, path) || ".";
  return new Error(`Access denied: ${display} ${reason}`);
}

export function assertWorkspacePath(inputPath: string, rootPath?: string): string {
  const root = realpathSync(resolve(rootPath || process.env.GITHUB_WORKSPACE || process.cwd()));
  const normalizedInput = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  const target = resolve(root, normalizedInput || ".");
  if (isOutside(root, target)) {
    throw denied(target, root, "is outside the repository workspace");
  }

  const parts = relative(root, target).split(sep).filter(Boolean);
  if (parts.some((part) => part.toLowerCase() === ".git") || blockedBasename.test(basename(target))) {
    throw denied(target, root, "is not available to review tools");
  }

  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw denied(current, root, "is not available to review tools");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }

  try {
    const realTarget = realpathSync(target);
    if (isOutside(root, realTarget)) {
      throw denied(target, root, "is outside the repository workspace");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

export default function registerWorkspaceGuard(pi: ExtensionAPI): void {
  const root = realpathSync(resolve(process.env.GITHUB_WORKSPACE || process.cwd()));
  pi.on("tool_call", (event) => {
    if (!guardedTools.has(event.toolName)) return;
    const path = (event.input as { path?: unknown }).path;
    try {
      assertWorkspacePath(typeof path === "string" ? path : ".", root);
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
