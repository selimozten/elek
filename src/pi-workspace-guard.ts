import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const guardedTools = new Set(["read", "grep", "find", "ls"]);
const blockedBasename = /^(?:\.env(?:\..*)?|.*(?:secret|credential|private[-_]?key|token).*\.(?:json|ya?ml|toml|txt|env|pem|key))$/i;

// Pi's tool path normalization (utils/paths.js normalizePath with the tool
// options): Unicode spaces, one `@` prefix, `~`, and file:// URLs. The guard
// must judge the path Pi will open, so it applies the same steps first;
// otherwise `~` reads as a workspace entry named "~" while Pi searches HOME.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function normalizeToolPath(input: string): string {
  let path = input.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  // On Windows Pi also converts MSYS drive paths (/c, /mnt/c, /cygdrive/c)
  // to native ones. Rather than mirror that, refuse them: none names a
  // workspace file that a relative path could not.
  if (process.platform === "win32" && /^\/(?:mnt\/|cygdrive\/)?[a-z](?:[\\/]|$)/i.test(path)) {
    throw new Error(`Access denied: ${path} is outside the repository workspace`);
  }
  if (path === "~") return homedir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(homedir(), path.slice(2));
  }
  if (/^file:\/\//.test(path)) return fileURLToPath(path);
  return path;
}

function isProtectedName(name: string): boolean {
  return name.toLowerCase() === ".git" || blockedBasename.test(name);
}

// NTFS ignores trailing dots and spaces (`.git.` is `.git`) and opens a
// file's data stream through `name::$DATA`, so such names alias others.
function isWindowsAlias(name: string): boolean {
  return process.platform === "win32" && (/[. ]$/.test(name) || name.includes(":"));
}

/** A path component review tools must never see. */
export function isProtectedComponent(name: string): boolean {
  return isWindowsAlias(name) || isProtectedName(name) || isProtectedName(name.normalize("NFKC"));
}

function isOutside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function denied(path: string, root: string, reason: string): Error {
  const display = relative(root, path) || ".";
  return new Error(`Access denied: ${display} ${reason}`);
}

/**
 * Every file Pi's read may open for a path: the path itself, then the macOS
 * AM/PM, NFD, curly-apostrophe and NFD+curly spellings it falls back to when
 * the first does not exist (core/tools/path-utils.js resolveReadPathAsync).
 * A guard that checks only the first lets an alternate spelling, or a
 * symlink named by one, open a file it would refuse.
 */
export function readPathCandidates(inputPath: string, rootPath: string): string[] {
  const resolved = resolve(rootPath, normalizeToolPath(inputPath) || ".");
  const nfd = resolved.normalize("NFD");
  return [...new Set([
    resolved,
    resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
    nfd,
    resolved.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ])];
}

/** Check a tool's path input as Pi will resolve it. */
export function assertWorkspacePath(inputPath: string, rootPath?: string): string {
  const root = realpathSync(resolve(rootPath || process.env.GITHUB_WORKSPACE || process.cwd()));
  return assertResolvedPath(resolve(root, normalizeToolPath(inputPath) || "."), root);
}

/** Check a real path: already resolved, so no tool-input normalization. */
function assertResolvedPath(target: string, root: string): string {
  if (isOutside(root, target)) {
    throw denied(target, root, "is outside the repository workspace");
  }

  // Every component, so `.env.d/prod` is covered like `.git/config`, and in
  // NFKC too, so look-alikes such as the Kelvin sign in `toKen` still match.
  const parts = relative(root, target).split(sep).filter(Boolean);
  if (parts.some(isProtectedComponent)) {
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

// grep prints `path:N: text`, and `path-N- text` for context lines. A file
// name can itself contain either delimiter, so every split is a candidate.
const grepDelimiter = /(?::\d+: |-\d+- )/g;

/**
 * Every path a result line could name, relative to the searched directory.
 * A grep line yields one candidate per delimiter; a line with none (a notice
 * such as "No matches found") names nothing. A find or ls line is a path.
 */
function resultLinePaths(toolName: string, line: string): string[] {
  if (toolName === "grep") {
    return [...line.matchAll(grepDelimiter)].map((match) => line.slice(0, match.index)).filter(Boolean);
  }
  const trimmed = line.replace(/\/$/, "");
  return trimmed ? [trimmed] : [];
}

/**
 * Drop result lines that name a protected path. The call-time check only sees
 * the path a tool was given; grep and find search hidden files beneath it,
 * so a search of "." would otherwise reach `.git/config` and secret files.
 */
export function filterToolText(
  toolName: string,
  inputPath: unknown,
  text: string,
  rootPath: string,
): { text: string; withheld: number } {
  let realRoot: string;
  let searchRoot: string;
  try {
    realRoot = realpathSync(resolve(rootPath));
    searchRoot = resolve(realRoot, typeof inputPath === "string" && inputPath ? normalizeToolPath(inputPath) : ".");
    // grep on a single file prints bare basenames, so its lines resolve
    // against the file's directory. The call-time check vetted that file.
    try {
      if (statSync(searchRoot).isFile()) searchRoot = dirname(searchRoot);
    } catch {
      // A missing root yields no results to filter.
    }
  } catch {
    // Fail closed: if the paths cannot be judged, nothing path-like passes.
    const lines = text.split("\n");
    const kept = lines.filter((line) => resultLinePaths(toolName, line).length === 0);
    return { text: kept.join("\n"), withheld: lines.length - kept.length };
  }
  const lines = text.split("\n");
  // A file name containing a newline splits one grep line into fragments
  // that each parse as something else. Every grep line must be a match, a
  // context line, a bracketed notice, or empty; anything else withholds all.
  if (toolName === "grep" && lines.some((line) => line !== "" && !/^\[.*\]$/.test(line) && line !== "No matches found" && resultLinePaths(toolName, line).length === 0)) {
    return { text: "", withheld: lines.length };
  }
  let withheld = 0;
  const kept = lines.filter((line) => {
    // Fail closed: one protected candidate withholds the whole line.
    for (const named of resultLinePaths(toolName, line)) {
      try {
        assertResolvedPath(resolve(searchRoot, named), realRoot);
      } catch {
        withheld += 1;
        return false;
      }
    }
    return true;
  });
  return { text: kept.join("\n"), withheld };
}

export default function registerWorkspaceGuard(pi: ExtensionAPI): void {
  const root = realpathSync(resolve(process.env.GITHUB_WORKSPACE || process.cwd()));
  pi.on("tool_call", (event) => {
    if (!guardedTools.has(event.toolName)) return;
    const path = (event.input as { path?: unknown }).path;
    try {
      // Only read falls back to other spellings; grep, find and ls open the
      // path as given.
      const input = typeof path === "string" ? path : ".";
      const candidates = event.toolName === "read"
        ? readPathCandidates(input, root)
        : [resolve(root, normalizeToolPath(input) || ".")];
      for (const candidate of candidates) {
        assertResolvedPath(candidate, root);
      }
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "grep" && event.toolName !== "find" && event.toolName !== "ls") return;
    // A failed call (bad pattern, missing path) keeps its error: replacing it
    // with an empty result would read to the model as a clean search.
    if (event.isError) return;
    let withheld = 0;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const filtered = filterToolText(event.toolName, (event.input as { path?: unknown }).path, part.text, root);
      withheld += filtered.withheld;
      return { ...part, text: filtered.text };
    });
    if (withheld === 0) return;
    // Withhold silently. A notice, a count, or a limit message counting the
    // withheld matches would tell a model whether a protected file matched
    // its pattern, and prefix patterns could then spell out the contents.
    const remaining = content.map((part) => part.type === "text"
      ? { ...part, text: part.text.split("\n").filter((line) => !/^\[.*\]$/.test(line)).join("\n").trim() }
      : part);
    const empty = remaining.every((part) => part.type !== "text" || part.text === "");
    if (empty) {
      const none = event.toolName === "grep" ? "No matches found" : event.toolName === "find" ? "No files found matching pattern" : "(empty directory)";
      return { content: [{ type: "text", text: none }] };
    }
    return { content: remaining };
  });
}
