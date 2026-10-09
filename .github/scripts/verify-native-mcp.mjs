import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temp = process.env.RUNNER_TEMP;
const parseLines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean)
  .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const traces = readdirSync(temp).filter((file) => /^native-mcp-.*\.jsonl$/.test(file));
const sessions = traces.map((file) => {
  const events = parseLines(join(temp, file));
  const starts = events.filter((event) => event.type === "tool_execution_start");
  const ends = events.filter((event) => event.type === "tool_execution_end");
  return {
    file,
    starts,
    successes: starts.filter((start) => ends.some((end) => end.toolCallId === start.toolCallId && !end.isError)),
  };
});
const posting = sessions.find((session) => session.file === "native-mcp-prompt.jsonl");
const candidates = sessions.filter((session) => session.file.startsWith("native-mcp-lens-"));
const inlineTool = "mcp__elek_review__create_inline_comment";
const trackingTool = "mcp__elek_review__update_tracking_comment";
const bufferFile = join(temp, "elek-inline-buffer.jsonl");
const buffered = existsSync(bufferFile) ? parseLines(bufferFile) : [];
const evidence = {
  conclusion: process.env.REVIEW_CONCLUSION,
  costUsd: Number(process.env.REVIEW_COST_USD || 0),
  sessions: sessions.map((session) => ({
    file: session.file,
    toolCalls: session.starts.map((event) => event.toolName),
    successfulToolCalls: session.successes.map((event) => event.toolName),
  })),
  bufferedFindings: buffered.map(({ path, line }) => ({ path, line })),
  trackingCommentUrl: null,
  inlineCommentUrls: [],
};
const save = () => writeFileSync(join(temp, "native-mcp-verification.json"), JSON.stringify(evidence, null, 2));
save();

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  assert.ok(response.ok, `GitHub ${path} returned ${response.status}`);
  return response.json();
}

assert.equal(evidence.conclusion, "success", "The composite Action must complete successfully");
assert.ok(candidates.some((session) => session.file === "native-mcp-lens-risk.jsonl") && candidates.some((session) => session.file === "native-mcp-lens-design.jsonl"), "Crosscheck must run both candidate reviewers");
for (const candidate of candidates) {
  assert.ok(candidate.starts.every((event) => !event.toolName.startsWith("mcp__")), "Candidate reviewers must not post");
}
assert.ok(posting?.successes.some((event) => event.toolName === inlineTool && event.args.confirmed !== true), "Native inline-comment buffering must succeed");
assert.ok(posting.successes.some((event) => event.toolName === trackingTool), "Native tracking-comment update must succeed");
const finding = buffered.find((entry) => entry.path === "fixtures/native-mcp/session.js");
assert.ok(finding, "The server must write the tenant finding to the inline buffer");
const comments = await github(`pulls/${process.env.PR_NUMBER}/comments?per_page=100`);
const delivered = comments.find((comment) => comment.path === finding.path && comment.body.includes(finding.body));
assert.ok(delivered, "GitHub must contain the inline finding buffered through native MCP");
const tracking = await github(`issues/comments/${process.env.TRACKING_COMMENT_ID}`);
assert.match(tracking.body, /tenant/i, "The final tracking comment must contain the review");
assert.match(tracking.body, /analysis complete/i, "Progress must finish before the final review body");
evidence.trackingCommentUrl = tracking.html_url;
evidence.inlineCommentUrls = [delivered.html_url];
save();
console.log(JSON.stringify(evidence, null, 2));
