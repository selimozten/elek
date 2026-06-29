import { constants, lstatSync, realpathSync } from "fs";
import { access, readFile, readdir, stat } from "fs/promises";
import { basename, relative, resolve, sep } from "path";
import { Type } from "typebox";
import {
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const workspaceRoot = realpathSync(resolve(process.env.GITHUB_WORKSPACE || process.cwd()));
const maxSearchBytes = 128 * 1024;
const maxSearchResults = 100;

const blockedBasename = /^(?:\.env(?:\..*)?|.*(?:secret|credential|private[-_]?key|token).*\.(?:json|ya?ml|toml|txt|env|pem|key))$/i;
const blockedSegments = new Set([".git"]);
const skippedSearchDirs = new Set([".git", "node_modules"]);

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function workspaceRelative(absolutePath: string): string {
  return toPosix(relative(workspaceRoot, absolutePath));
}

function isOutsideWorkspace(absolutePath: string): boolean {
  const rel = relative(workspaceRoot, absolutePath);
  return rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel;
}

function assertNotBlocked(absolutePath: string): void {
  const rel = relative(workspaceRoot, absolutePath);
  const parts = rel.split(sep).filter(Boolean);
  if (parts.some((part) => blockedSegments.has(part)) || blockedBasename.test(basename(absolutePath))) {
    throw new Error(`Access denied: ${workspaceRelative(absolutePath)} is not available to review tools`);
  }
}

function assertNoSymlinkSegments(absolutePath: string): void {
  const parts = relative(workspaceRoot, absolutePath).split(sep).filter(Boolean);
  let current = workspaceRoot;
  for (const part of parts) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Access denied: ${workspaceRelative(current)} is not available to review tools`);
    }
  }
}

export function assertWorkspacePath(absolutePath: string): string {
  const resolved = resolve(absolutePath);
  if (isOutsideWorkspace(resolved)) {
    throw new Error(`Access denied: ${workspaceRelative(resolved)} is outside the repository workspace`);
  }

  assertNotBlocked(resolved);
  assertNoSymlinkSegments(resolved);

  const realResolved = realpathSync(resolved);
  if (isOutsideWorkspace(realResolved)) {
    throw new Error(`Access denied: ${workspaceRelative(resolved)} is outside the repository workspace`);
  }
  assertNotBlocked(realResolved);
  return realResolved;
}

function pathFromTool(inputPath: string | undefined): string {
  return assertWorkspacePath(resolve(workspaceRoot, inputPath || "."));
}

function globToRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$+?.()|{}[]".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesGlob(relativePath: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  const normalized = toPosix(relativePath);
  const regex = globToRegex(pattern);
  return pattern.includes("/") ? regex.test(normalized) : regex.test(basename(normalized));
}

async function collectFiles(root: string, options: {
  pattern?: string;
  limit: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    if (options.signal?.aborted || files.length >= options.limit) return;
    const entries = await readdir(assertWorkspacePath(dir), { withFileTypes: true });
    for (const entry of entries) {
      if (options.signal?.aborted || files.length >= options.limit) return;
      if (skippedSearchDirs.has(entry.name) || blockedBasename.test(entry.name)) continue;
      const fullPath = assertWorkspacePath(resolve(dir, entry.name));
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const rel = workspaceRelative(fullPath);
        if (matchesGlob(rel, options.pattern)) files.push(fullPath);
      }
    }
  };

  const rootStat = await stat(assertWorkspacePath(root));
  if (rootStat.isDirectory()) {
    await visit(root);
  } else if (rootStat.isFile() && matchesGlob(workspaceRelative(root), options.pattern)) {
    files.push(root);
  }
  return files;
}

const findTool = defineTool({
  name: "find",
  label: "find",
  description: "Find repository files by glob pattern. Search is read-only and confined to the GitHub workspace.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts' or 'src/**/*.test.ts'" }),
    path: Type.Optional(Type.String({ description: "Directory to search in, relative to the repository workspace" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
  }),
  async execute(_toolCallId, params, signal) {
    const limit = Math.min(Math.max(1, params.limit ?? 1000), 5000);
    const root = pathFromTool(params.path);
    const files = await collectFiles(root, { pattern: params.pattern, limit, signal });
    if (files.length === 0) {
      return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
    }
    const text = files.map((file) => workspaceRelative(file)).join("\n");
    const suffix = files.length >= limit ? `\n\n[${limit} results limit reached]` : "";
    return { content: [{ type: "text", text: `${text}${suffix}` }], details: files.length >= limit ? { resultLimitReached: limit } : undefined };
  },
});

const grepTool = defineTool({
  name: "grep",
  label: "grep",
  description: "Search repository file contents. Search is read-only and confined to the GitHub workspace.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Search pattern, as regex by default or literal when literal=true" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search, relative to the repository workspace" })),
    glob: Type.Optional(Type.String({ description: "Optional file glob, e.g. '*.ts' or '**/*.test.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
    context: Type.Optional(Type.Number({ description: "Number of context lines before and after each match" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches" })),
  }),
  async execute(_toolCallId, params, signal) {
    const limit = Math.min(Math.max(1, params.limit ?? maxSearchResults), 1000);
    const context = Math.min(Math.max(0, params.context ?? 0), 10);
    const root = pathFromTool(params.path);
    const files = await collectFiles(root, { pattern: params.glob, limit: 20_000, signal });
    const flags = params.ignoreCase ? "i" : "";
    const regex = params.literal
      ? null
      : new RegExp(params.pattern, flags);
    const needle = params.ignoreCase && params.literal ? params.pattern.toLowerCase() : params.pattern;
    const output: string[] = [];

    for (const file of files) {
      if (signal?.aborted || output.length >= limit) break;
      const buffer = await readFile(assertWorkspacePath(file));
      if (buffer.includes(0)) continue;
      let content = buffer.toString("utf-8");
      if (Buffer.byteLength(content, "utf-8") > maxSearchBytes) {
        content = content.slice(0, maxSearchBytes);
      }
      const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      for (let index = 0; index < lines.length && output.length < limit; index += 1) {
        const line = lines[index]!;
        const haystack = params.ignoreCase && params.literal ? line.toLowerCase() : line;
        const matched = regex ? regex.test(line) : haystack.includes(needle);
        if (!matched) continue;
        const start = Math.max(0, index - context);
        const end = Math.min(lines.length - 1, index + context);
        for (let current = start; current <= end && output.length < limit; current += 1) {
          const marker = current === index ? ":" : "-";
          output.push(`${workspaceRelative(file)}${marker}${current + 1}${marker} ${lines[current]!.slice(0, 500)}`);
        }
      }
    }

    if (output.length === 0) {
      return { content: [{ type: "text", text: "No matches found" }], details: undefined };
    }
    const suffix = output.length >= limit ? `\n\n[${limit} matches limit reached]` : "";
    return { content: [{ type: "text", text: `${output.join("\n")}${suffix}` }], details: output.length >= limit ? { matchLimitReached: limit } : undefined };
  },
});

export default function registerReadonlyTools(pi: ExtensionAPI) {
  pi.registerTool(createReadToolDefinition(workspaceRoot, {
    operations: {
      access: (absolutePath) => access(assertWorkspacePath(absolutePath), constants.R_OK),
      readFile: (absolutePath) => readFile(assertWorkspacePath(absolutePath)),
      detectImageMimeType: async () => null,
    },
  }));

  pi.registerTool(createLsToolDefinition(workspaceRoot, {
    operations: {
      exists: async (absolutePath) => {
        try {
          await access(assertWorkspacePath(absolutePath), constants.R_OK);
          return true;
        } catch {
          return false;
        }
      },
      stat: (absolutePath) => stat(assertWorkspacePath(absolutePath)),
      readdir: async (absolutePath) => {
        const entries = await readdir(assertWorkspacePath(absolutePath));
        return entries.filter((entry) => !skippedSearchDirs.has(entry) && !blockedBasename.test(entry));
      },
    },
  }));

  pi.registerTool(findTool);
  pi.registerTool(grepTool);
}
