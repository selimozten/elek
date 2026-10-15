/**
 * Trigger detection for the elek action.
 * Checks if the event should trigger pi based on mentions, labels, assignees, or explicit prompts.
 */
import type { GitHubEntityContext, ActionInputs } from "../types";
import { resolveMode } from "./mode";

/** Pull request actions that change what a reviewer would see. */
export const AUTO_REVIEW_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

/** Request used when a pull_request event triggers a review by itself. */
export const DEFAULT_REVIEW_REQUEST =
  "Review this pull request for correctness, security, performance, and " +
  "maintainability. Reference specific files and lines.";

/**
 * Check if the current event context contains a trigger for pi to act.
 * Returns the extracted user prompt text, or null if not triggered.
 */
export function detectTrigger(
  context: GitHubEntityContext,
  inputs: ActionInputs,
): string | null {
  // Explicit prompt from workflow config always triggers
  if (inputs.prompt) {
    return inputs.prompt;
  }

  const trigger = inputs.triggerPhrase.toLowerCase();
  const text = context.triggerText.toLowerCase();

  // Check for trigger phrase in comment/body
  const idx = findTriggerIndex(text, trigger);
  if (idx >= 0) {
    // Extract everything after the trigger phrase as the user's request
    const afterTrigger = context.triggerText.substring(idx + trigger.length).trim();
    return afterTrigger || context.triggerText;
  }

  // Check for assignee trigger (configured assignee username)
  if (context.issue?.assignees) {
    // If the issue has assignees, check if any match (useful for triage workflows)
    // Keep assignee matching simple and explicit.
  }

  // Check for label trigger
  if (context.issue?.labels) {
    const labelTrigger = "pi"; // default label trigger
    if (context.issue.labels.some((l) => l.toLowerCase() === labelTrigger)) {
      return context.triggerText;
    }
  }

  if (shouldAutoReview(context, inputs)) {
    return DEFAULT_REVIEW_REQUEST;
  }

  return null;
}

/**
 * A workflow subscribed to pull_request events is asking for reviews; the
 * README and elek-init promise one on every push. Agent mode can push
 * commits, so it still needs an explicit prompt, phrase, or label.
 */
export function shouldAutoReview(
  context: GitHubEntityContext,
  inputs: ActionInputs,
): boolean {
  return (
    inputs.autoReview &&
    context.eventName === "pull_request" &&
    AUTO_REVIEW_ACTIONS.has(context.eventAction) &&
    context.pr?.draft !== true &&
    !resolveMode(inputs.mode).allowEdit
  );
}

/**
 * Check if the actor is allowed to trigger pi.
 * Filters out bots by default unless explicitly allowed.
 */
export function isActorAllowed(context: GitHubEntityContext, inputs: ActionInputs): boolean {
  const actor = context.actor;

  // Empty filter = trusted repository actors only, deny bots. Public
  // repositories should opt in broader users explicitly with actor_filter.
  if (!inputs.actorFilter && !inputs.allowedBots) {
    return !actor.endsWith("[bot]") && isTrustedAssociation(context.actorAssociation);
  }

  // Allow all
  if (inputs.actorFilter === "*" || inputs.allowedBots === "*") {
    return true;
  }

  // Check explicit filter list
  if (inputs.actorFilter) {
    const allowed = inputs.actorFilter.split(",").map((s) => s.trim());
    if (allowed.includes(actor)) return true;
  }

  // Check allowed bots
  if (inputs.allowedBots) {
    const allowedBots = inputs.allowedBots.split(",").map((s) => s.trim());
    if (allowedBots.includes(actor)) return true;
  }

  return false;
}

export interface ActorPermissionRequest {
  owner: string;
  repo: string;
  actor: string;
}

export type ActorPermissionLookup = (request: ActorPermissionRequest) => Promise<string | undefined>;

/**
 * Authorize an actor using webhook association first, then a live repository
 * permission lookup when GitHub supplies stale or missing association data.
 * Explicit actor/bot filters remain authoritative and never use the fallback.
 */
export async function isActorAuthorized(
  context: GitHubEntityContext,
  inputs: ActionInputs,
  lookupPermission?: ActorPermissionLookup,
): Promise<boolean> {
  if (isActorAllowed(context, inputs)) return true;

  if (
    inputs.actorFilter ||
    inputs.allowedBots ||
    context.actor.endsWith("[bot]") ||
    !lookupPermission
  ) {
    return false;
  }

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

function findTriggerIndex(text: string, trigger: string): number {
  if (!trigger) return -1;
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(trigger, from);
    if (index < 0) return -1;
    const before = index > 0 ? text[index - 1] : "";
    const after = text[index + trigger.length] ?? "";
    if (isBoundary(before) && isBoundary(after)) return index;
    from = index + 1;
  }
  return -1;
}

function isBoundary(char: string): boolean {
  return char === "" || /[\s.,:;!?()[\]{}<>"'`]/.test(char);
}

function isTrustedAssociation(value: string | undefined): boolean {
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

function isTrustedPermission(value: string | undefined): boolean {
  return value === "admin" || value === "maintain" || value === "write" || value === "triage";
}
