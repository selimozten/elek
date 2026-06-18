export function spinnerHtml(): string {
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Header line for tracking/progress comments. Wrapped in a single HTML
 * paragraph so GitHub's markdown renderer keeps the status compact and
 * stable across progress updates.
 */
export function spinnerHeader(modelLabel: string, status = "analyzing…"): string {
  void modelLabel;
  return `<p><strong>elek</strong> review: ${escapeHtml(status)}</p>`;
}
