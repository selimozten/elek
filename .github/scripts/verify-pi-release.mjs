import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const temp = process.env.RUNNER_TEMP;
const read = (name) => existsSync(join(temp,name)) ? readFileSync(join(temp,name),'utf8') : '';
const events = read('native-pi-prompt.jsonl').split('\n').filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const tools = events.filter(event => event.type === 'tool_execution_start').map(event => event.toolName);
const evidence = {
  conclusion: process.env.REVIEW_CONCLUSION,
  piVersion: read('pi-version.txt').trim(),
  sessionCount: events.filter(event => event.type === 'session').length,
  mcpDisabled: read('pi-args.txt').split('\n').includes('--no-mcp'),
  toolCalls: tools,
  costUsd: Number(process.env.REVIEW_COST_USD || 0),
  trackingCommentUrl: null,
  inlineCommentUrl: null,
};
const save = () => writeFileSync(join(temp,'latest-pi-verification.json'),JSON.stringify(evidence,null,2));
save();
assert.equal(evidence.conclusion,'success');
assert.equal(evidence.piVersion,'1.1.0');
assert.equal(evidence.sessionCount,1,'Exactly one real Pi review session');
assert.ok(evidence.mcpDisabled,'Native MCP discovery is explicitly disabled');
assert.ok(tools.every(tool => ['read','grep','find','ls'].includes(tool)),'Only native read-only tools may run');

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  assert.ok(response.ok,`GitHub returned ${response.status}`);
  return response.json();
}
const comments = await github(`pulls/${process.env.PR_NUMBER}/comments?per_page=100`);
const inline = comments.find(comment => comment.path === 'fixtures/pi-release/session.js' && /tenant/i.test(comment.body));
assert.ok(inline,'Host must deliver the tenant finding inline');
const tracking = await github(`issues/comments/${process.env.TRACKING_COMMENT_ID}`);
assert.match(tracking.body,/tenant/i);
assert.match(tracking.body,/analysis complete/i);
evidence.trackingCommentUrl = tracking.html_url;
evidence.inlineCommentUrl = inline.html_url;
save();
console.log(JSON.stringify(evidence,null,2));
