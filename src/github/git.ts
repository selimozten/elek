/**
 * Git operations for the pi action:
 * - Configure git auth
 * - Create/checkout branches
 * - Commit signing
 */
import { execSync } from "child_process";
import type { GitHubEntityContext } from "../types";

const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || "https://github.com";

/**
 * Configure git authentication using the GitHub token.
 */
export function configureGitAuth(githubToken: string, context: GitHubEntityContext): void {
  const serverUrl = new URL(GITHUB_SERVER_URL);
  const noreplyDomain =
    serverUrl.hostname === "github.com"
      ? "users.noreply.github.com"
      : `users.noreply.${serverUrl.hostname}`;

  const botName = "pi[bot]";
  const botId = "pi-bot";

  execSync(`git config user.name "${botName}"`, { stdio: "inherit" });
  execSync(`git config user.email "${botId}@${noreplyDomain}"`, { stdio: "inherit" });

  // Remove existing auth headers (from actions/checkout)
  try {
    execSync(`git config --unset-all http.${GITHUB_SERVER_URL}/.extraheader`, { stdio: "pipe" });
  } catch {
    // No existing headers to remove — fine
  }

  // Set remote URL with token
  const remoteUrl = `https://x-access-token:${githubToken}@${serverUrl.host}/${context.repo.owner}/${context.repo.repo}.git`;
  execSync(`git remote set-url origin "${remoteUrl}"`, { stdio: "inherit" });

  console.log("✓ Git authentication configured");
}

/**
 * Create a new branch for pi's work.
 * Returns the branch name.
 */
export function createPiBranch(
  context: GitHubEntityContext,
  prefix: string,
): string {
  const timestamp = Date.now();
  const entityType = context.isPR ? "pr" : "issue";
  const branchName = `${prefix}${entityType}-${context.entityNumber}-${timestamp}`;

  execSync(`git checkout -b "${branchName}"`, { stdio: "inherit" });
  console.log(`✓ Created branch: ${branchName}`);

  return branchName;
}

/**
 * Switch to the base branch (for PR context).
 */
export function checkoutBaseBranch(baseRef: string): void {
  execSync(`git checkout "${baseRef}"`, { stdio: "inherit" });
  console.log(`✓ Checked out base branch: ${baseRef}`);
}

/**
 * Stage all changes and commit.
 */
export function commitChanges(message: string): void {
  execSync("git add -A", { stdio: "inherit" });
  try {
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: "inherit" });
    console.log(`✓ Committed: ${message}`);
  } catch {
    console.log("Nothing to commit");
  }
}

/**
 * Push the current branch to origin.
 */
export function pushBranch(branchName: string): void {
  execSync(`git push origin "${branchName}" --force`, { stdio: "inherit" });
  console.log(`✓ Pushed branch: ${branchName}`);
}

/**
 * Get the git diff between two refs.
 */
export function getGitDiff(baseRef: string, headRef: string): string {
  // Fetch both refs first
  execSync(`git fetch origin "${baseRef}" "${headRef}" --depth=100`, { stdio: "pipe" });

  try {
    return execSync(`git diff "origin/${baseRef}...origin/${headRef}"`, {
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });
  } catch {
    // Fallback to diff against base
    try {
      return execSync(`git diff "origin/${baseRef}"`, {
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch {
      return "";
    }
  }
}
