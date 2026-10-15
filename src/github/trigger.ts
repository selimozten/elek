/**
 * Decide whether a pull_request event gets a review, and whether its actor
 * is trusted to spend the repository's model key.
 */
import type { GitHubEntityContext } from "../types";

/** Pull request actions that change what a reviewer would see. */
export const REVIEW_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

/** Draft pull requests wait until they are marked ready for review. */
export function shouldReview(context: GitHubEntityContext): boolean {
  return REVIEW_ACTIONS.has(context.eventAction) && context.pr.draft !== true;
}

export interface ActorPermissionRequest {
  owner: string;
  repo: string;
  actor: string;
}

export type ActorPermissionLookup = (request: ActorPermissionRequest) => Promise<string | undefined>;

/**
 * Trust repository owners, members, and collaborators; deny bots. When the
 * webhook association is stale or missing, fall back to a live repository
 * permission lookup.
 */
export async function isActorAuthorized(
  context: GitHubEntityContext,
  lookupPermission?: ActorPermissionLookup,
): Promise<boolean> {
  if (context.actor.endsWith("[bot]")) return false;
  if (isTrustedAssociation(context.actorAssociation)) return true;
  if (!lookupPermission) return false;

  try {
    const permission = await lookupPermission({
      owner: context.repo.owner,
      repo: context.repo.repo,
      actor: context.actor,
    });
    return isTrustedPermission(permission);
  } catch {
    return false;
  }
}

function isTrustedAssociation(value: string | undefined): boolean {
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

function isTrustedPermission(value: string | undefined): boolean {
  return value === "admin" || value === "maintain" || value === "write" || value === "triage";
}
