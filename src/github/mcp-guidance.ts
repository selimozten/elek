export function mcpToolGuidance(): string[] {
  return [
    "You have an `mcp` proxy tool. Tool names are server-prefixed; ours are `elek_review_*`. Two operations:",
    "",
    '- `mcp({tool: "elek_review_create_inline_comment", args: "{\\"path\\":\\"...\\",\\"line\\":N,\\"body\\":\\"...\\"}"})`',
    "  Post a finding on a specific line of the diff. For multi-line ranges, add `startLine`.",
    "  Optional fields: `side`, `startLine`, `confirmed`, and `commit_id`.",
    "  Buffered by default — only sent at the end of the run. Set `confirmed: true` to post immediately.",
    "  Use markdown suggestion blocks for actionable fixes:",
    "    ```suggestion",
    "    new code here",
    "    ```",
    "",
    '- `mcp({tool: "elek_review_update_tracking_comment", args: "{\\"body\\":\\"...\\"}"})`',
    "  Replace the body of your tracking comment. Use this to maintain a live todo checklist as you work.",
    "",
    'Note: `args` is a JSON STRING (not an object). If you forget the prefix, use `mcp({search: "<keyword>"})` to discover the right name.',
    "",
    "These are the ONLY ways your inline-comment output is visible. Console output is discarded.",
  ];
}
