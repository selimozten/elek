# Changelog

All notable changes to elek will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.2] - 2026-06-13

### Added

- MIT license file and security policy for vulnerability reporting.
- Weekly Dependabot maintenance for GitHub Actions and npm dependencies.
- CI audit gate for high-severity runtime dependency advisories.
- Exact top-level dependency pins for more predictable action installs.
- CodeQL code scanning workflow for JavaScript/TypeScript security analysis.

### Changed

- Composite action runtime installs now omit dev dependencies and avoid
  writing a transient package lockfile.
- Dependabot version-update policy now defers semver-major upgrades to manual
  migration PRs.
- Runtime MCP adapter dependency updated to `pi-mcp-adapter` 2.10.0.

## [1.1.1] - 2026-06-13

### Changed

- Switch the secondary self-review workflow to OpenRouter Kimi K2.7 Code.
- Keep the low-level `tools` input limited to legacy `agent` mode; review
  modes always use their safe mode presets.
- Refresh model examples to current Claude, OpenAI, OpenRouter, and DeepSeek
  review choices, including provider-specific reasoning-effort notes.

### Removed

- Drop the deprecated secondary-provider action input and examples; use
  OpenRouter or another supported provider instead.

### Fixed

- Align generated review prompts with the actual tool surface for `review`,
  `review+edit`, and legacy `agent` modes.
- Avoid telling `review+edit` models to run shell/git commands when MCP is
  disabled but `bash` is still unavailable.
- Warn when `crosscheck` or `council` is configured outside `mode: review`
  instead of silently falling back to solo review.

## [1.1.0] - 2026-06-13

### Added

- Elek branding assets and updated action, package, and README branding.
- `solo`, `crosscheck`, and `council` review strategies for single-model,
  multi-model, and review-council runs.
- Read-only candidate review lenses and final validator synthesis for
  cross-model review flows.

### Changed

- Default generated work branches now use the `elek/` prefix, and contributor
  docs now describe professional branch and PR naming conventions.
- Self-review workflow is advisory while the regular CI workflow remains the
  hard merge gate.
- Action/runtime dependencies moved to the maintained pi package and current
  GitHub Actions runtime packages.

### Fixed

- Inline review posting now validates diff anchors before posting.
- Buffered review comments are grouped into one GitHub review where possible,
  with a fallback issue comment when inline anchors are invalid.
- Advisory self-review prompts now tell models to verify external version
  claims before treating them as findings.

## [1.0.0] - 2026-06-13

### Added

- **Mode system** (`mode` input): `review` (default), `review+edit`, `agent`.
  Each mode picks a tool allowlist and toggles MCP injection. `review` is
  read-only with inline-comment posting; `agent` is the legacy full-bash mode.
- **Review-only MCP server** (`src/mcp/github-review-server.ts`) exposing
  exactly two tools: `create_inline_comment` and `update_tracking_comment`.
  The model can post line-specific review threads but cannot approve, merge,
  or close; that is structural, not a runtime check.
- **Iterate-on-prior-reviews**: `<comments>` block in the prompt now includes
  the bot's own previous reviews. Prompt instructs the model to open with a
  status update for each prior finding before listing new ones.
- **Animated pi-logo spinner** (SVG) for the tracking comment header,
  replacing the previous GIF. Works on fork PRs because the URL points to
  `selimozten/elek@main` rather than `${GITHUB_HEAD_REF}`.
- **CI workflow** (`.github/workflows/ci.yml`): `bun test` + `tsc --noEmit`
  on every PR.
- **AGENTS.md** + **docs/ARCHITECTURE.md** for coding agents and contributors.

### Changed

- Default tools tightened: `read,grep,find,ls,mcp` (was
  `read,write,edit,bash,grep,find,ls`).
- `pi --mode json` is the default; previously fell back to text mode after
  CI hangs were debugged.
- Tracking comment dedup now uses signature only (no bot-login filter), so
  PATs and GitHub Apps reuse the same comment instead of accumulating new
  ones.
- Final review truncation bumped from 4,000 to 60,000 chars (GitHub's
  comment limit is 65,536).

### Fixed

- Pi child-process hang in CI (8-minute zero-output stall before the 30-min
  timeout). Root cause: stdin left open with `stdio: ["pipe", ...]`. Fixed by
  switching to `stdio: ["ignore", ...]`.
- `mcp` proxy tool was filtered by the `--tools` allowlist, leaving the
  model with no path to the MCP server. Now included in `review` and
  `review+edit` modes.
- Race between progress-update and final-review-post overwrote the review
  body. `pi.ts` now `await`s `onProgress({type:"done"})` before resolving.
- `confirmed: false` opt-out was dead in production: handlers wrote the
  buffer entry without the `confirmed` field. Now propagated.
- `pulls.get()` was called even when the model supplied a `commit_id`,
  wasting one API call per inline comment. Now skipped.
- `ensureHeadSha` retried on every entry after a failure, amplifying rate
  limits. Now caches the failure.
- `parseInt` of a non-numeric `trackingCommentId` produced `NaN`. Now
  validated with `Number.isFinite`.
- `package-lock.json` no longer committed (gitignored; composite Action
  installs fresh in CI).
- Type-check (`bunx tsc --noEmit`) passes; previously had latent Octokit
  adapter mismatches.
