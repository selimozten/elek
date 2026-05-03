# Contributing to elek

Thanks for considering a contribution. elek is small and tightly scoped on
purpose — please read [AGENTS.md](AGENTS.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before opening a PR for non-trivial work.

## Quick setup

```bash
git clone https://github.com/selimozten/elek
cd elek
bun install
bun test test/
bunx tsc --noEmit
```

That's it. No build step needed for development; the action runs `tsx`
directly against the source.

## Local testing against a real PR

```bash
DEEPSEEK_API_KEY=sk-… \
GITHUB_EVENT_NAME=pull_request \
GITHUB_EVENT_PATH=/path/to/event.json \
GITHUB_REPOSITORY=user/repo \
GITHUB_TOKEN=ghp_… \
RUNNER_TEMP=/tmp \
INPUT_PROVIDER=deepseek \
INPUT_MODEL=deepseek-v4-pro \
INPUT_THINKING=high \
INPUT_MODE=review \
tsx src/entrypoints/run.ts
```

You'll need a fake `event.json` with a `pull_request` payload. Easiest way:
trigger a real run, find the run logs, copy the event JSON from the env
dump.

## What we welcome

- **Bug fixes** with a regression test.
- **New providers** — pi already supports them; usually a one-line addition
  to `action.yml` + `pi.ts`'s key-vars list.
- **Prompt improvements** that demonstrably tighten review quality (show
  before/after on a real PR in the description).
- **Documentation** — especially diagrams (mermaid) and missing edge cases.

## What we'll likely push back on

- Widening the MCP server's tool surface beyond
  `create_inline_comment` / `update_tracking_comment`. The structural
  safety guarantee is load-bearing.
- Adding an `@anthropic-ai/sdk` (or any model-specific SDK) import. pi
  handles providers; staying model-agnostic is the value prop.
- Refactors that don't fix a problem. If you want to restructure something,
  open an issue first to align on the goal.

## PR checklist

- [ ] `bun test test/` passes
- [ ] `bunx tsc --noEmit` is clean
- [ ] New behavior has a test
- [ ] Comments explain WHY, not WHAT (names already say what)
- [ ] No `package-lock.json` in the diff (gitignored)
- [ ] No new MCP tools, no new model SDK imports, no new bash escape hatches

## Commit messages

Conventional-ish: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`.
First line ≤ 72 chars; body wrapping at 72 if you have one. The body is the
PR description in miniature — explain *why* the change exists.

## Reporting bugs

Use [the bug template](.github/ISSUE_TEMPLATE/bug_report.md). Include:

- The action version (or commit SHA) you're using
- Workflow YAML (redact secrets)
- What you expected, what happened
- Run logs (link to the GitHub Actions run if public)

## Questions

Open a discussion before opening an issue if you're not sure it's a bug.
