/**
 * Git operations for the elek action:
 * - Configure git auth
 * - Create/checkout branches
 * - Commit signing
 */
import { execFileSync, type ExecFileSyncOptions } from "child_process";
import type { GitHubEntityContext } from "../types";

const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || "https://github.com";
const maxGitRefLength = 255;

function git(args: string[], options: ExecFileSyncOptions = {}): void {
  execFileSync("git", args, options);
}

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

/**
 * Configure git authentication using the GitHub token.
 */
export function configureGitAuth(githubToken: string, context: GitHubEntityContext): void {
  const serverUrl = new URL(GITHUB_SERVER_URL);
  const noreplyDomain =
    serverUrl.hostname === "github.com"
      ? "users.noreply.github.com"
      : `users.noreply.${serverUrl.hostname}`;

  const botName = "elek[bot]";
  const botId = "elek-bot";

  git(["config", "user.name", botName], { stdio: "inherit" });
  git(["config", "user.email", `${botId}@${noreplyDomain}`], { stdio: "inherit" });

  // Remove existing auth headers (from actions/checkout)
  try {
    git(["config", "--unset-all", `http.${GITHUB_SERVER_URL}/.extraheader`], { stdio: "pipe" });
  } catch {
    // No existing headers to remove — fine
  }

  // Set remote URL with token
  const remoteUrl = `https://x-access-token:${githubToken}@${serverUrl.host}/${context.repo.owner}/${context.repo.repo}.git`;
  git(["remote", "set-url", "origin", remoteUrl], { stdio: "inherit" });

  console.log("✓ Git authentication configured");
}

/**
 * Create a new branch for elek's work.
 * Returns the branch name.
 */
export function createElekBranch(
  context: GitHubEntityContext,
  prefix: string,
): string {
  const timestamp = Date.now();
  const entityType = context.isPR ? "pr" : "issue";
  const branchName = `${prefix}${entityType}-${context.entityNumber}-${timestamp}`;
  assertSafeGitRefName(branchName, "elek branch name");

  git(["checkout", "-b", branchName], { stdio: "inherit" });
  console.log(`✓ Created branch: ${branchName}`);

  return branchName;
}

/**
 * Switch to the base branch (for PR context).
 */
export function checkoutBaseBranch(baseRef: string): void {
  assertSafeGitRefName(baseRef, "base ref");
  git(["checkout", baseRef], { stdio: "inherit" });
  console.log(`✓ Checked out base branch: ${baseRef}`);
}

/**
 * Stage all changes and commit.
 */
export function commitChanges(message: string): void {
  git(["add", "-A"], { stdio: "inherit" });
  try {
    git(["commit", "-m", message], { stdio: "inherit" });
    console.log(`✓ Committed: ${message}`);
  } catch {
    console.log("Nothing to commit");
  }
}

/**
 * Push the current branch to origin.
 */
export function pushBranch(branchName: string): void {
  assertSafeGitRefName(branchName, "push branch name");
  git(["push", "origin", branchName, "--force"], { stdio: "inherit" });
  console.log(`✓ Pushed branch: ${branchName}`);
}

/**
 * Get the git diff between two refs.
 */
export function getGitDiff(baseRef: string, headRef: string): string {
  const headFetchRef = process.env.ELEK_HEAD_FETCH_REF || headRef;
  const headRemoteRef = process.env.ELEK_HEAD_REMOTE_REF || headRef;
  assertSafeGitRefName(baseRef, "base ref");
  assertSafeGitRefName(headRef, "head ref");
  assertSafeGitRefName(headFetchRef, "head fetch ref");
  assertSafeGitRefName(headRemoteRef, "head remote ref");

  if (process.env.ELEK_HEAD_FETCH_REF) {
    git(["fetch", "origin", baseRef, "--depth=100"], { stdio: "pipe" });
    git(["fetch", "origin", `${headFetchRef}:refs/remotes/origin/${headRemoteRef}`, "--depth=100"], { stdio: "pipe" });
  } else {
    // Fetch both refs first
    git(["fetch", "origin", baseRef, headRef, "--depth=100"], { stdio: "pipe" });
  }

  try {
    return execFileSync("git", ["diff", `origin/${baseRef}...origin/${headRemoteRef}`], {
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });
  } catch {
    // Fallback to diff against base
    try {
      return execFileSync("git", ["diff", `origin/${baseRef}`], {
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch {
      return "";
    }
  }
}
