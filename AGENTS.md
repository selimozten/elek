# AGENTS.md

Instructions for coding agents working in this repository.

## Runtime and boundaries

Elek wraps the Pi CLI as a composite GitHub Action. Read
`src/entrypoints/run.ts` before changing the review flow. One model session
reviews the supplied diff with the selected lenses; the host sanitizes its
final answer and posts GitHub comments through Octokit.

Review mode exposes only Pi's native `read`, `grep`, `find`, and `ls` tools.
`src/pi-workspace-guard.ts` blocks paths outside the repository, `.git`,
secret files, and symlink escapes. Pi receives no `GITHUB_TOKEN` in review
mode. Keep these boundaries intact.

Pi has a built-in MCP client. Elek runs with `--no-mcp` because the host owns
GitHub delivery. Keep MCP adapters, servers, and generated configuration out
of the review flow. There must be no review code path to approving, merging,
or closing a pull request. Discuss any expansion of that boundary first.

Legacy `agent` mode can edit files and push commits in trusted workflows.
`review+edit` stays read-only until mutation tools can be sandboxed.

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
- Pi requires a model with `--provider`. An empty provider-qualified pattern
  such as `deepseek/` selects an available model within that provider.
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
