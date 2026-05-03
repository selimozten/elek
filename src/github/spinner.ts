/**
 * Animated pi-logo spinner — used in both the initial tracking comment
 * and the progressive checklist updates so the visual stays consistent.
 *
 * Loaded from the action's home repo on `main` so fork PRs (where
 * GITHUB_HEAD_REF doesn't exist in the base repo) don't 404.
 */
const SPINNER_URL =
  "https://raw.githubusercontent.com/selimozten/elek/main/assets/spinner.svg";

export function spinnerHtml(): string {
  return `<img src="${SPINNER_URL}" width="14" height="14" alt="⏳" style="vertical-align: middle; margin-left: 4px;" />`;
}

/**
 * Header line for tracking/progress comments. Wrapped in a single HTML
 * paragraph so GitHub's markdown renderer keeps the spinner inline with
 * the model name + status text — otherwise an `<img>` at line start
 * gets promoted to its own line by GitHub's media handling.
 */
export function spinnerHeader(modelLabel: string, status = "analyzing…"): string {
  return `<p>${spinnerHtml()} <strong>${modelLabel}</strong> ${status}</p>`;
}
