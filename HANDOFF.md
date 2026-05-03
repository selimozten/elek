# elek — Handoff Document

## What is elek?

Model-agnostic GitHub Actions code review bot powered by [pi coding agent](https://github.com/badlogic/pi-mono). Two AI models review every PR independently. Works with any provider pi supports (DeepSeek, OpenAI, Anthropic, Z.AI, Groq, etc.).

**Repo:** https://github.com/selimozten/elek  
**Status:** Working core, needs UX polish and race condition fixes

---

## Architecture

```
action.yml → npm install → run.ts (single orchestrator)
    ├── context.ts     Parse GitHub event (PR/issue/comment)
    ├── trigger.ts     Detect @pi mentions, actor filtering
    ├── data.ts        Fetch PR diff, issue body, comments via GitHub API
    ├── progress.ts    Format progressive checklist comments
    ├── comments.ts    Create/update/dedup tracking comments
    ├── git.ts         Git auth, branches, commits, push
    └── pi.ts          Run pi CLI in streaming JSON mode
```

**Key design decisions:**
- Composite GitHub Action (not JavaScript action)
- pi runs via CLI, not SDK (model-agnostic by design)
- `--mode json` for streaming progress events
- Model-specific comment signatures (`<!-- elek-bot:provider/model -->`) to prevent collision

---

## Current State

### What works
- [x] Dual-model reviews (DeepSeek + Z.AI) on PRs
- [x] Model-specific comment deduplication
- [x] PR diff fetching and structured prompt building
- [x] XML-tagged prompt format (inspired by Claude Code Action)
- [x] Spinner GIF in tracking comments (dynamic branch URL)
- [x] Comment fetching for review context
- [x] Tests for progress comment formatting (6 passing)

### What's broken / incomplete
- [ ] **Progressive comment updates don't work reliably** — JSON mode streaming may not output events in the expected format, or the event parsing misses events. Comments often stay at "analyzing..." or update only once.
- [ ] **Stale comments accumulate** — old "analyzing..." comments from previous runs are never cleaned up. The dedup finds them but creates new ones anyway on subsequent pushes.
- [ ] **no-session flag may be incorrect** — pi might be using `--no-session` when it should persist sessions for debugging.
- [ ] **Z.AI 401 error** — key works locally but fails in GitHub Actions (possible IP restriction on Z.AI API).
- [ ] **No tests for integration paths** — only progress formatting is tested. Context parsing, trigger detection, data fetching all untested.

---

## Files to focus on

| File | Purpose | Issues |
|------|---------|--------|
| `src/pi.ts` | pi CLI runner, JSON streaming | JSON event format may need debugging. `--mode json` events might differ from what's parsed |
| `src/entrypoints/run.ts` | Main orchestrator | Rate limiting (3s) might miss events. Comment update error handling is bare |
| `src/github/comments.ts` | Comment management | Dedup finds but doesn't properly handle multi-push scenarios |
| `src/github/data.ts` | Data fetching + prompt building | Comment truncation not implemented. Type interface leaked to test file |
| `src/github/progress.ts` | Progressive checklist formatting | Pure function, well-tested |
| `test/progress.test.ts` | Progress formatting tests | 6 passing. Good pattern to follow for other modules |

## The workflow

```yaml
# .github/workflows/elek.yml — dual-model review
jobs:
  deepseek:
    steps:
      - uses: actions/checkout@v4
      - uses: ./   # Self-referencing for dogfooding
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          provider: deepseek
          model: deepseek-v4-pro
          thinking: high
          
  zai:
    steps:
      - uses: actions/checkout@v4  
      - uses: ./
        with:
          zai_api_key: ${{ secrets.ZAI_API_KEY }}
          provider: zai
          model: glm-5.1
          thinking: high
```

---

## Known bugs

1. **JSON mode output format mismatch** — `pi.ts` parses JSON lines expecting fields like `event.assistantMessageEvent.type`, `event.toolName`. The actual JSON mode output from pi may use different field names. Need to capture a sample JSONL output from pi `--mode json` and align the parser.

2. **Comment dedup across pushes** — When a new push happens, `findExistingComment` finds the OLD comment (already updated to "analysis complete"). But the code then creates a new "analyzing..." comment anyway because the old one doesn't match the initial template. Fix: should find ANY comment with the model's signature and reuse it, regardless of current content.

3. **Spinner on fork PRs** — `getSpinnerHtml()` uses `GITHUB_HEAD_REF` which on fork PRs points to a branch that doesn't exist in the base repo. The raw.githubusercontent.com URL 404s. Should fall back to ⏳ when `GITHUB_REPOSITORY` owner differs from the head repo, or add `onerror` handler to the img tag.

4. **`--no-session` means no resumability** — If a review is interrupted (timeout, crash), there's no way to resume. Consider using persistent sessions with `--session-dir`.

---

## Desired UX improvements

### Progressive comment updates (like Claude Code)
Claude Code updates the SAME comment with a dynamic checklist as it works:
```
⏳ analyzing…
- [x] Reading project structure
- [x] Analyzing diff (342 lines changed)
- [ ] Running tests
- [ ] Writing review
```

elek should do the same. The `progress.ts` module has the formatting logic. The gap is in `pi.ts` — JSON mode event parsing needs to correctly map pi's events to the progress state transitions.

### Single comment per model per PR
Currently each push creates new comments. Should be:
- First push: creates "analyzing..." comment
- Subsequent pushes on same PR: REUSES the same comment (find by model signature, update in place)
- Final: same comment gets updated with review

The `findExistingComment` already finds the comment, but the logic needs to always reuse instead of creating new.

### Better error visibility
When pi fails (API key, timeout, etc.), the error message should be clear in the comment. Currently errors are just logged to console but the comment might stay at "analyzing...".

### Clean up old comments
Option: on the `finally` block, delete comments older than the current one that have the same model signature.

---

## How to debug pi JSON mode

Run this locally to see the actual JSON event format:

```bash
cd /path/to/elek
ZAI_API_KEY="your-key" pi --mode json --provider zai --model glm-5.1 \
  --thinking off --no-session --no-extensions --no-skills \
  --no-context-files -p "Say hello and list files in current directory" \
  2>/dev/null | head -30
```

The output is JSONL (one JSON object per line). Match the field names against `pi.ts`'s event parser (around line 100).

---

## Testing

Run tests:
```bash
cd /path/to/elek
bun test
```

Current coverage: only `test/progress.test.ts` (6 tests on pure formatting function).

**Tests to add:**
- `test/context.test.ts` — parse PR, issue, comment event payloads
- `test/trigger.test.ts` — @pi detection, actor filtering
- `test/data.test.ts` — prompt building with various inputs
- `test/pi.test.ts` — mock spawn, verify args built correctly

Follow the existing pattern: test pure functions, mock I/O boundaries.

---

## Secrets needed on the repo

```
DEEPSEEK_API_KEY  — DeepSeek v4 Pro
ZAI_API_KEY       — Z.AI GLM-5.1
```

Set via: `gh secret set NAME --body "key" --repo selimozten/elek`

---

## Quick start for a new agent

```bash
git clone https://github.com/selimozten/elek.git
cd elek
npm install
bun test                    # Verify tests pass
cat src/entrypoints/run.ts  # Start here — main orchestrator
```

The data flow is: GitHub event → context.ts → trigger.ts → data.ts (fetch + build prompt) → pi.ts (run model) → comments.ts (post results).

---

## Reference: Claude Code Action patterns

Claude Code Action files are at `../claude-code-action/` relative to the elek repo. Key files to study:
- `src/github/operations/comments/common.ts` — spinner, job link, initial comment template
- `src/create-prompt/index.ts` — full prompt generation (very detailed instructions)
- `src/github/data/formatter.ts` — structured context formatting
- `src/github/operations/comments/create-initial.ts` — comment dedup via bot user ID
