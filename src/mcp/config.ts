import { writeFileSync } from "fs";
import { join } from "path";

export const REVIEW_MCP_TOOLS = [
  "mcp__elek_review__create_inline_comment",
  "mcp__elek_review__update_tracking_comment",
] as const;

export function writeReviewMcpConfig(agentDir: string, options: {
  actionPath: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  commentId?: number;
  bufferPath: string;
}): void {
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
    autoEnableCodemode: false,
    mcpServers: {
      "elek-review": {
        command: join(options.actionPath, "node_modules", ".bin", "tsx"),
        args: [join(options.actionPath, "src", "mcp", "github-review-server.ts")],
        exposure: "direct",
        env: {
          REPO_OWNER: options.repoOwner,
          REPO_NAME: options.repoName,
          PR_NUMBER: String(options.prNumber),
          ELEK_TRACKING_COMMENT_ID: options.commentId ? String(options.commentId) : "",
          ELEK_BUFFER_PATH: options.bufferPath,
        },
      },
    },
  }, null, 2), "utf-8");
}
