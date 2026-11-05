# AGENTS.md

Instructions for coding agents working in this repository.

## Runtime and boundaries

Elek is a self-hosted composite GitHub Action that wraps the Pi CLI. Read
`src/entrypoints/run.ts` before changing the review flow. On a non-draft
`pull_request` event, one model session reviews the diff with the built-in
risk and design lenses. The host sanitizes the final answer and posts GitHub
comments through Octokit. There is no hosted service.

Pi gets only its native `read`, `grep`, `find`, and `ls` tools, and runs in
a copy of the checkout's tracked files (`src/review-workspace.ts`) with no
`.git`, no untracked files, and no protected names. `src/pi-workspace-guard.ts`
also blocks paths outside that copy, protected names, and symlink escapes, and
filters search results. Pi receives no `GITHUB_TOKEN`. Keep these boundaries
intact.

Pi has a built-in MCP client. Elek runs with `--no-mcp` because the host owns
GitHub delivery. Keep MCP adapters, servers, and generated configuration out
of the review flow. There must be no review code path to approving, merging,
or closing a pull request. Discuss any expansion of that boundary first.

Keep the Action small. New inputs, triggers, or modes need a concrete user
problem that the existing inputs and `.elek.yml` cannot solve.

## Implementation

- Use strict TypeScript. Keep the deliberately loose Octokit adapter types
  in `comments.ts` and `post-buffered.ts`; the full Octokit generic types do
  not fit their injected dependency interfaces.
- Add a failing regression test before changing behavior. Prefer pure
  functions with injected dependencies; see `test/post-buffered.test.ts`.
- Keep changes focused. Use Pi's provider support rather than importing
  model-specific SDKs. Comments explain non-obvious constraints and choices.
- Close Pi stdin with `stdio:["ignore","pipe","pipe"]`; an open pipe can
  leave a noninteractive CLI waiting for input.
- Await the final progress update before publishing the review so it cannot
  overwrite the final comment.
- Pi requires a model with `--provider`. With no model input, Elek passes
  neither flag and forwards only the selected provider's key, so Pi starts on
  its own default model for that provider. Providers Elek has no key input for
  need an explicit model.
- Keep `package-lock.json` synchronized with `package.json`. The Action uses
  `npm ci --omit=dev`; CI installs and audits the same lockfile on Node 24.

## Delivery

Use work prefixes such as `feature/`, `fix/`, `docs/`, `refactor/`, `test/`,
`ci/`, `chore/`, `security/`, or `release/`, followed by a lowercase kebab-case
summary. PR titles use Conventional Commit style.

Before pushing, run `bun test test/`, `bunx tsc --noEmit`, and
`npm audit --omit=dev --audit-level=high`. CI and CodeQL must pass before
merging. Address actionable advisory review findings; provider quota and
transient model failures are advisory.

See `docs/ARCHITECTURE.md` for the review flow and `docs/setup.md` for Action
configuration.
