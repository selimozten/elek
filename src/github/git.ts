/**
 * Read-only git access: build the PR diff from the checked-out refs.
 */
import { execFileSync } from "child_process";

const maxGitRefLength = 255;

export function isSafeGitRefName(ref: string): boolean {
  if (!ref || ref.length > maxGitRefLength) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) return false;
  if (ref.startsWith("-") || ref.endsWith("/") || ref.endsWith(".")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return false;
  return ref
    .split("/")
    .every((segment) => segment && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

function assertSafeGitRefName(ref: string, label: string): void {
  if (!isSafeGitRefName(ref)) {
    throw new Error(`Unsafe ${label}: ${ref}`);
  }
}

function assertSafeGitObjectId(objectId: string, label: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(objectId)) {
    throw new Error(`Unsafe ${label}: ${objectId}`);
  }
}

function refContainsCommit(ref: string, commit: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function refEqualsCommit(ref: string, commit: string): boolean {
  try {
    const resolved = execFileSync("git", ["rev-parse", `${ref}^{commit}`], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return resolved.toLowerCase() === commit.toLowerCase();
  } catch {
    return false;
  }
}

function diffRange(range: string): string | undefined {
  try {
    return execFileSync("git", ["diff", range], {
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/**
 * Get the git diff between two refs.
 */
export function getGitDiff(baseRef: string, headRef: string, headSha?: string): string {
  assertSafeGitRefName(baseRef, "base ref");
  assertSafeGitRefName(headRef, "head ref");
  if (headSha) assertSafeGitObjectId(headSha, "head SHA");

  // actions/checkout with fetch-depth: 0 already provides the base ref and
  // current PR checkout. Prefer those trusted local refs so read-only review
  // jobs do not need persisted git credentials merely to build the diff. A
  // verified head SHA prevents a checkout of the default branch from being
  // mistaken for the PR checkout.
  if (!headSha || refContainsCommit("HEAD", headSha)) {
    const localHeadDiff = diffRange(`origin/${baseRef}...HEAD`);
    if (localHeadDiff !== undefined) return localHeadDiff;
  }

  if (!headSha || refEqualsCommit(`origin/${headRef}`, headSha)) {
    const localRemoteDiff = diffRange(`origin/${baseRef}...origin/${headRef}`);
    if (localRemoteDiff !== undefined) return localRemoteDiff;
  }

  if (headSha) {
    throw new Error(`PR head ${headSha} is unavailable in the checked-out git refs`);
  }

  throw new Error("PR head is unavailable in the checked-out git refs");
}
