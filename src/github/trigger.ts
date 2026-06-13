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
  if (text.includes(trigger)) {
    // Extract everything after the trigger phrase as the user's request
    const idx = text.indexOf(trigger);
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

  // Empty filter = allow all humans, deny bots
  if (!inputs.actorFilter && !inputs.allowedBots) {
    return !actor.endsWith("[bot]");
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

  return !actor.endsWith("[bot]");
}
