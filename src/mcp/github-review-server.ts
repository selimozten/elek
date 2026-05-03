#!/usr/bin/env node
/**
 * Review-only MCP server — thin wiring on top of src/mcp/handlers.ts.
 *
 * The server exposes EXACTLY two tools and no others:
 *   - create_inline_comment   → posts to pulls.createReviewComment
 *   - update_tracking_comment → updates a pinned issues comment_id
 *
 * There is no code path here for pulls.createReview (event=APPROVE),
 * pulls.merge, or issues.update(state=closed). The model cannot reach
 * those endpoints by any prompt, because they aren't plumbed.
 *
 * Reads its configuration from env vars set by the elek action runner:
 *   REPO_OWNER, REPO_NAME, PR_NUMBER       — required
 *   GITHUB_TOKEN                            — required
 *   ELEK_TRACKING_COMMENT_ID                — optional (enables update_tracking_comment)
 *   ELEK_BUFFER_PATH                        — optional, default /tmp/elek-inline-buffer.jsonl
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync } from "fs";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import {
  createInlineComment,
  updateTrackingComment,
  type Deps,
  type ToolResult,
} from "./handlers.js";

const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const PR_NUMBER = process.env.PR_NUMBER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TRACKING_COMMENT_ID = process.env.ELEK_TRACKING_COMMENT_ID;
const BUFFER_PATH = process.env.ELEK_BUFFER_PATH || "/tmp/elek-inline-buffer.jsonl";

if (!REPO_OWNER || !REPO_NAME || !PR_NUMBER) {
  console.error("REPO_OWNER, REPO_NAME, PR_NUMBER must all be set");
  process.exit(1);
}
if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN must be set");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN }).rest;

const deps: Deps = {
  octokit,
  appendBuffer: (line) => appendFileSync(BUFFER_PATH, line),
  env: {
    repoOwner: REPO_OWNER,
    repoName: REPO_NAME,
    prNumber: PR_NUMBER,
    trackingCommentId: TRACKING_COMMENT_ID,
  },
};

function asMcpResult(r: ToolResult) {
  if (r.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(r.data, null, 2) }],
    };
  }
  return {
    content: [{ type: "text" as const, text: `Error: ${r.error}` }],
    isError: true,
  };
}

const server = new McpServer({ name: "elek Review Server", version: "0.1.0" });

server.tool(
  "create_inline_comment",
  "Post a code-review comment on a specific line or line range in the PR diff. Use suggestion blocks (```suggestion) for actionable fixes. Without confirmed=true the call is buffered and posted by the action's post-step.",
  {
    path: z.string().describe("File path being reviewed"),
    body: z.string().describe("Markdown comment body. Code suggestions: ```suggestion ... ```"),
    line: z.number().int().nonnegative().optional().describe("Line for single-line comments"),
    startLine: z.number().int().nonnegative().optional().describe("Start line for multi-line"),
    side: z.enum(["LEFT", "RIGHT"]).optional().default("RIGHT"),
    commit_id: z.string().optional().describe("Specific commit SHA; defaults to PR head"),
    confirmed: z.boolean().optional().describe("Set true ONLY for final, intentional review comments"),
  },
  async (args) => asMcpResult(await createInlineComment(deps, args)),
);

server.tool(
  "update_tracking_comment",
  "Update the elek tracking comment that this run is associated with. Body fully replaces the prior content.",
  { body: z.string().describe("New markdown body") },
  async (args) => asMcpResult(await updateTrackingComment(deps, args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.on("exit", () => server.close());
