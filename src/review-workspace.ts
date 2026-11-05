import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isProtectedComponent } from "./pi-workspace-guard";

/** Bounds each git call so a pathological repository cannot stall the run. */
const GIT_TIMEOUT_MS = 120_000;
/** Pi reviews source; a larger blob is generated or binary and is skipped. */
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const BLOBS_PER_BATCH = 1000;
/** Per cat-file call, so many large blobs cannot outgrow the output buffer. */
const BATCH_BYTES = 64 * 1024 * 1024;
const MAX_SUBMODULE_DEPTH = 8;
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;

/**
 * The directory Pi reviews: the reviewed commit's tracked files, including
 * initialized submodules at the commits it records, without `.git`,
 * untracked files, symlinks, or anything with a protected name.
 *
 * Elek computes the diff itself before Pi starts, and Pi only reads, greps,
 * finds and lists. Checking paths around a live checkout cannot be made
 * airtight: grep and find search hidden files under an allowed root, apply
 * their match and size limits before any filter, and print names that can
 * imitate their own output format. A protected file that is not there
 * cannot leak through any of that.
 *
 * Files are written from raw blobs, not checked out: checkout applies
 * smudge filters that a tracked .gitattributes selects from local git
 * configuration, and would run them with the action's environment.
 */
export function createReviewWorkspace(source: string, tempRoot: string): string {
  const destination = mkdtempSync(join(tempRoot, "elek-review-"));
  try {
    exportCommit(source, "HEAD", destination, 0, new PathClaims(destination), "");
    return destination;
  } catch (error) {
    removeQuietly(destination);
    throw error;
  }
}

interface TreeEntry {
  mode: string;
  object: string;
  size: number | undefined;
  path: string;
}

function exportCommit(
  repository: string,
  commit: string,
  destination: string,
  depth: number,
  claims: PathClaims,
  prefix: string,
): void {
  const entries = listTree(repository, commit);
  // Regular files only: symlinks could point anywhere, and gitlinks are
  // exported below at their recorded commits. Sizes are read only for what
  // survives, so a partial clone never has to fetch an excluded blob.
  const candidates = entries.filter((entry) =>
    (entry.mode === "100644" || entry.mode === "100755") && isSafeRelativePath(entry.path));
  const blobs = withSizes(repository, commit, candidates).filter((entry) =>
    entry.size !== undefined && entry.size <= MAX_BLOB_BYTES);
  // Claim every path before any content is written; an alias is left out.
  const writable = blobs.filter((blob) => claims.claim(`${prefix}${blob.path}`));
  for (const batch of batches(writable)) writeBlobs(repository, batch, destination);

  for (const entry of entries) {
    if (entry.mode !== "160000" || !isSafeRelativePath(entry.path)) continue;
    const submodule = join(repository, entry.path);
    if (depth >= MAX_SUBMODULE_DEPTH || !hasCommit(submodule, entry.object)) {
      console.warn(`Review workspace: submodule ${JSON.stringify(entry.path)} is not available at ${entry.object}; leaving it out`);
      continue;
    }
    const target = join(destination, entry.path);
    if (!claims.claim(`${prefix}${entry.path}`, true)) continue;
    exportCommit(submodule, entry.object, target, depth + 1, claims, `${prefix}${entry.path}/`);
  }
}

/**
 * Paths created in the copy, each under the exact spelling git gave it.
 * The copy starts empty and only Elek writes into it, so a component the
 * filesystem reports as existing that was never created under that spelling
 * is an alias of one that was: `A` and `a` on a case-insensitive volume,
 * two Unicode spellings of one name, `SS` and `ẞ`. Asking the filesystem
 * agrees with its own name equivalence in both directions, which no
 * case-folding rule does. A filesystem that folds nothing never reports one.
 */
class PathClaims {
  private readonly made = new Map<string, "dir" | "file">();

  constructor(private readonly root: string) {}

  /**
   * Create a path's folders, and the file itself unless `directory`, or
   * return false when any part aliases a path already created.
   */
  claim(path: string, directory = false): boolean {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join("/");
      const kind = i < parts.length || directory ? "dir" : "file";
      const made = this.made.get(spelling);
      if (made === "dir" && kind === "dir") continue;
      if (made !== undefined) {
        warnCollision(path);
        return false;
      }
      const target = join(this.root, spelling);
      try {
        if (existsSync(target)) throw Object.assign(new Error("alias"), { code: "EEXIST" });
        if (kind === "dir") mkdirSync(target);
        else writeFileSync(target, "", { flag: "wx" });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTDIR" && code !== "EISDIR") throw error;
        warnCollision(path);
        return false;
      }
      this.made.set(spelling, kind);
    }
    return true;
  }
}

/** Groups blobs by count and by bytes, sizes being known beforehand. */
function batches(blobs: TreeEntry[]): TreeEntry[][] {
  const result: TreeEntry[][] = [];
  let current: TreeEntry[] = [];
  let bytes = 0;
  for (const blob of blobs) {
    const size = (blob.size ?? 0) + 128;
    if (current.length > 0 && (current.length >= BLOBS_PER_BATCH || bytes + size > BATCH_BYTES)) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(blob);
    bytes += size;
  }
  if (current.length > 0) result.push(current);
  return result;
}

/**
 * Two git paths that one filesystem cannot tell apart (`A` and `a` on a
 * case-insensitive volume, or two Unicode spellings of one name): the first
 * written wins and the other is left out, rather than overwriting it or
 * failing the review.
 */
function warnCollision(path: string): void {
  console.warn(`Review workspace: ${JSON.stringify(path)} collides with another path on this filesystem; leaving it out`);
}

/** `ls-tree -r -z`: "<mode> <type> <object>\t<path>\0"; no sizes, no fetches. */
function listTree(repository: string, commit: string): TreeEntry[] {
  const output = git(repository, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const entries: TreeEntry[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    const record = output.subarray(start, end < 0 ? output.length : end);
    start = end < 0 ? output.length : end + 1;
    const tab = record.indexOf(9);
    if (tab < 0) continue;
    const [mode, , object] = record.subarray(0, tab).toString("latin1").trim().split(/ +/);
    const pathBytes = record.subarray(tab + 1);
    const path = pathBytes.toString("utf8");
    // A path that is not valid UTF-8 cannot be named faithfully; leave it out.
    if (!Buffer.from(path, "utf8").equals(pathBytes)) continue;
    entries.push({ mode, object, size: undefined, path });
  }
  return entries;
}

/** Objects of one commit's tree that this clone does not have ("?<oid>"). */
function missingObjects(repository: string, commit: string): Set<string> {
  const output = git(repository, ["rev-list", "--objects", "--no-walk", "--missing=print", commit]).toString("latin1");
  const missing = new Set<string>();
  for (const line of output.split("\n")) if (line.startsWith("?")) missing.add(line.slice(1).trim());
  return missing;
}

/**
 * Sizes from `cat-file --batch-check`, one "<object> <type> <size>" line per
 * request. Objects a partial clone lacks are found first, without fetching
 * on any git version (GIT_NO_LAZY_FETCH only exists from git 2.45), and left
 * out rather than downloaded.
 */
function withSizes(repository: string, commit: string, entries: TreeEntry[]): TreeEntry[] {
  const absent = missingObjects(repository, commit);
  const present = entries.filter((entry) => {
    if (!absent.has(entry.object)) return true;
    console.warn(`Review workspace: ${JSON.stringify(entry.path)} is not in this clone; leaving it out`);
    return false;
  });
  if (present.length === 0) return [];
  const lines = git(repository, ["cat-file", "--batch-check"], `${present.map((entry) => entry.object).join("\n")}\n`)
    .toString("latin1").split("\n");
  return present.map((entry, index) => {
    const [object, type, size] = (lines[index] ?? "").split(" ");
    if (object !== entry.object || type !== "blob" || !/^\d+$/.test(size ?? "")) return { ...entry, size: undefined };
    return { ...entry, size: Number(size) };
  });
}

/** `cat-file --batch`: "<object> blob <size>\n<content>\n" per request. */
function writeBlobs(repository: string, blobs: TreeEntry[], destination: string): void {
  const output = git(repository, ["cat-file", "--batch"], `${blobs.map((blob) => blob.object).join("\n")}\n`);
  let offset = 0;
  for (const blob of blobs) {
    // Strict framing: a corrupt object can come back shorter than its header.
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) throw new Error(`Truncated cat-file output at ${blob.object}`);
    const header = output.subarray(offset, headerEnd).toString("latin1").split(" ");
    const size = Number(header[2]);
    if (header.length !== 3 || header[0] !== blob.object || header[1] !== "blob"
      || !Number.isSafeInteger(size) || size !== blob.size) {
      throw new Error(`Unexpected cat-file output for ${blob.object}`);
    }
    const bodyEnd = headerEnd + 1 + size;
    if (bodyEnd >= output.length || output[bodyEnd] !== 10) {
      throw new Error(`Truncated cat-file output for ${blob.object}`);
    }
    const content = output.subarray(headerEnd + 1, bodyEnd);
    offset = bodyEnd + 1;
    writeEntry(destination, blob, content);
  }
  if (offset !== output.length) throw new Error("Unexpected trailing cat-file output");
}

function writeEntry(destination: string, blob: TreeEntry, content: Buffer): void {
  // PathClaims created the folders and an empty placeholder under this exact
  // spelling, so this fills the file it made.
  const target = join(destination, blob.path);
  writeFileSync(target, content);
  chmodSync(target, blob.mode === "100755" ? 0o755 : 0o644);
}

/**
 * A tree path Pi may see: relative, no empty, `.` or `..` component (git
 * rejects them, but a crafted object need not), and no protected name.
 */
function isSafeRelativePath(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) return false;
  if (parts.some(isProtectedComponent)) return false;
  const rel = relative("/review", resolve("/review", ...parts));
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== "..";
}

function hasCommit(repository: string, object: string): boolean {
  try {
    git(repository, ["cat-file", "-e", `${object}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Git with a minimal environment: no action inputs or tokens, no replace
 * refs (which could swap the reviewed commit for another tree), and no lazy
 * fetching in partial clones.
 */
function git(repository: string, args: string[], input?: string): Buffer {
  // The checkout Elek was handed may belong to another user on self-hosted
  // runners; trust exactly this repository for this command, nothing wider.
  const trusted = ["-c", `safe.directory=${realpathSync(repository)}`];
  return execFileSync("git", [...trusted, ...args], {
    cwd: repository,
    input,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT,
  });
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Under RUNNER_TEMP, which the runner clears; the caller's error matters more.
  }
}

/**
 * Best effort: on Windows a lingering rg or fd can hold the directory open,
 * and a failed cleanup must not replace the review's result. Leftovers sit
 * under RUNNER_TEMP, which the runner clears.
 */
export function removeReviewWorkspace(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Could not remove the review workspace ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
