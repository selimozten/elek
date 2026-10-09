import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeReviewMcpConfig } from "../src/mcp/config";

describe("Pi native review MCP configuration", () => {
  it("exposes review tools directly without adapter settings or embedded credentials", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "elek-mcp-config-"));
    try {
      writeReviewMcpConfig(agentDir, {
        actionPath: "/opt/elek",
        repoOwner: "owner",
        repoName: "repo",
        prNumber: 42,
        commentId: 123,
        bufferPath: "/tmp/inline.jsonl",
      });
      const config = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8"));
      expect(Object.keys(config.mcpServers)).toEqual(["elek-review"]);
      expect(config.autoEnableCodemode).toBe(false);
      expect(config.mcpServers["elek-review"]).toEqual({
        command: "/opt/elek/node_modules/.bin/tsx",
        args: ["/opt/elek/src/mcp/github-review-server.ts"],
        exposure: "direct",
        env: {
          REPO_OWNER: "owner",
          REPO_NAME: "repo",
          PR_NUMBER: "42",
          ELEK_TRACKING_COMMENT_ID: "123",
          ELEK_BUFFER_PATH: "/tmp/inline.jsonl",
        },
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
