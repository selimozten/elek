/**
 * Trigger detection for the elek action.
 * Checks if the event should trigger pi based on mentions, labels, assignees, or explicit prompts.
 */
import type { GitHubEntityContext, ActionInputs } from "../types";

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

  return null;
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
