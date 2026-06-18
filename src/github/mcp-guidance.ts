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
    "Use inline MCP comments for validated line-anchored findings. Elek will publish your concise final summary host-side.",
    "If any MCP/tool/gateway/transport call fails, do not mention that failure in the public review. Continue with the review content only.",
    "Never include thinking traces, scratch work, tool logs, or delivery/debug narration in final text.",
  ];
}
