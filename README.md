<p align="center">
  <img src="assets/elek-logo.png" width="360" alt="elek" />
</p>

<p align="center">
  <strong>Read-only AI code review for pull requests.</strong><br />
  A self-hosted GitHub Action. Bring your own model key.
</p>

<p align="center">
  <a href="https://github.com/selimozten/elek/actions/workflows/ci.yml"><img src="https://github.com/selimozten/elek/actions/workflows/ci.yml/badge.svg" alt="ci" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-171412.svg" alt="License: MIT" /></a>
</p>

elek reviews every pull request in your repository. When a PR is opened,
updated, reopened, or marked ready, the Action runs one
[Pi](https://github.com/earendil-works/pi) session against the diff. The
session uses the model you choose, with your key. elek then posts a summary
comment and inline comments on the changed lines.

elek is open source and runs entirely in your own GitHub Actions workflow.
There is no hosted service, account, or telemetry.

See it review a real tenant-isolation regression in
[elek-demo#1](https://github.com/selimozten/elek-demo/pull/1).

## Safety model

- The model gets Pi's `read`, `grep`, `find`, and `ls` tools and nothing else:
  no shell, no file writes, no MCP. A guard blocks paths outside the
  repository, `.git`, secret files, and symlink escapes.
- The model never receives `GITHUB_TOKEN`. elek posts the review itself.
- elek has no code path that approves, merges, closes, or pushes. Reviews post
  with the `COMMENT` event.
- elek redacts token-shaped secrets from the review before it posts.
- Review policy in `.elek.yml` loads from the base branch, so a PR cannot
  weaken its own review.

## One-minute setup

From your repository root, run:

```bash
npx --package github:selimozten/elek elek-init --provider deepseek
```

This writes `.github/workflows/elek.yml` and `.elek.yml`. Add the repository
secret `DEEPSEEK_API_KEY`, commit both files, and open a PR.

To use another provider, pass `--provider` and optionally `--model`:

```bash
npx --package github:selimozten/elek elek-init --provider anthropic --model claude-sonnet-4-6
npx --package github:selimozten/elek elek-init --provider openrouter --model moonshotai/kimi-k2.7-code
```

`elek-init --help` lists every flag. It refuses to overwrite existing files
unless you pass `--force`.

## Manual workflow

```yaml
name: elek

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: elek-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    # Fork PRs get no secrets and a read-only token, so elek skips them.
    if: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6.0.3
        with:
          fetch-depth: 0
      - uses: selimozten/elek@v1
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          provider: deepseek
          model: deepseek-v4-pro
          thinking: high
```

`fetch-depth: 0` lets elek build the diff and read the base-branch config from
the checkout.

## Inputs

| Input | Default | Description |
|---|---|---|
| `provider` | `anthropic` | Any Pi provider, for example `deepseek`, `openrouter`, `openai`, `google`, `opencode-go`. |
| `model` | provider default | Model ID, for example `deepseek-v4-pro` or `claude-sonnet-4-6`. |
| `thinking` | `medium` | Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `*_api_key` | none | The key for your provider. See [Providers](#providers). |
| `github_token` | `${{ github.token }}` | Token elek uses to post comments. The model never sees it. |
| `prompt` | built-in request | Replaces the default review request. The safety rules, review lenses, and response format still apply. |
| `run_timeout_seconds` | `0` | Stop the model run after this many seconds and report a failure. `0` means no timeout. |
| `config_path` | `.elek.yml` | Repository config file. Set `none`, `off`, or `false` to disable it. |
| `sticky_comment` | `true` | Show live progress and the review in one tracking comment. With `false`, elek posts a PR review only. |
| `severity_threshold` | from `.elek.yml` | Lowest severity to report: `critical`, `important`, or `minor`. |

## Repository config

`.elek.yml` keeps review policy next to the code:

```yaml
severity_threshold: important

knowledge_paths:
  - AGENTS.md
  - CONTRIBUTING.md
  - docs/ARCHITECTURE.md

ignore_paths:
  - docs/**
  - "*.md"

instructions:
  - Treat auth and permission changes as security-sensitive.
  - Require tests for parser and config changes.
```

| Key | Description |
|---|---|
| `severity_threshold` | Lowest severity to report. The `severity_threshold` input overrides it. |
| `knowledge_paths` | Repository docs to include as project context. When unset, elek tries `AGENTS.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, and `docs/adr`. elek caps the file count and size. |
| `ignore_paths` | Globs whose patches elek leaves out of the prompt. elek still reports a finding in an ignored path that breaks something elsewhere. |
| `instructions` | Extra review rules for your repository. |

On a pull request, elek reads `.elek.yml` and the knowledge files from the base
branch. If the base branch has no config, elek uses the checked-out one. elek
fails the run when the config file has malformed YAML, so a typo cannot drop
your policy without notice. Unknown keys log a warning.

## Providers

elek works with any provider Pi supports. Set `provider`, `model`, and the
matching key input:

| Input | Environment variable |
|---|---|
| `anthropic_api_key` | `ANTHROPIC_API_KEY` |
| `openai_api_key` | `OPENAI_API_KEY` |
| `google_api_key` | `GEMINI_API_KEY` |
| `deepseek_api_key` | `DEEPSEEK_API_KEY` |
| `groq_api_key` | `GROQ_API_KEY` |
| `mistral_api_key` | `MISTRAL_API_KEY` |
| `together_api_key` | `TOGETHER_API_KEY` |
| `xai_api_key` | `XAI_API_KEY` |
| `openrouter_api_key` | `OPENROUTER_API_KEY` |
| `opencode_api_key` | `OPENCODE_API_KEY` (OpenCode Zen and Go) |

For Amazon Bedrock, set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and
`AWS_SECRET_ACCESS_KEY` as job-level `env`. For Vertex, set
`GOOGLE_APPLICATION_CREDENTIALS` and `ANTHROPIC_VERTEX_PROJECT_ID`.

## Outputs

| Output | Description |
|---|---|
| `conclusion` | `success`, `failure`, or `skipped`. |
| `comment_id` | ID of the tracking comment. |
| `summary` | First 1,000 characters of the posted review. |
| `input_tokens` | Input tokens the review used. |
| `output_tokens` | Output tokens the review used. |

## Permissions

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
```

`contents: read` is enough because elek never pushes. `pull-requests: write`
posts the review and inline comments. `issues: write` posts the tracking
comment.

## FAQ

**Does elek review pull requests from forks?** No. GitHub gives fork
`pull_request` runs no repository secrets and a read-only token, so elek has no
model key and cannot post. The workflow above skips forks. Without that guard,
elek exits with a `skipped` conclusion. Do not switch to `pull_request_target`
to get secrets: that event runs with your secrets while the PR author controls
the code.

**What about draft pull requests?** elek skips drafts and reviews the PR when
you mark it ready for review.

**Which events does elek handle?** Only `pull_request` with the `opened`,
`synchronize`, `reopened`, or `ready_for_review` action. Other events end with
a warning and a `skipped` conclusion. elek also skips runs that a bot triggers
or that a user who is not a repository owner, member, or collaborator triggers.

**What does a review cost?** elek prints the token counts in the review footer
and in the `input_tokens` and `output_tokens` outputs. Multiply them by your
provider's prices. When the provider reports no usage, elek estimates the
counts from the prompt and response length and labels the line as estimated.

**What does the model check?** Every review applies two lenses. The risk lens
looks for bugs, security holes, breaking behavior, and side effects. The design
lens looks for structural regressions and needless complexity. The model then
drops findings it cannot verify against the changed code. `prompt` changes the
request but not these rules.

**Why are comments from `github-actions[bot]`?** The default `GITHUB_TOKEN`
posts as that account. If you pass a GitHub App or bot token as `github_token`,
set the job-level env `ELEK_TRACKING_COMMENT_AUTHORS` to that login so elek
reuses its own tracking comment on later pushes.

## Documentation

- [`docs/setup.md`](docs/setup.md) explains setup in more detail and covers
  troubleshooting.
- [`docs/examples.md`](docs/examples.md) has workflow recipes.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) describes how a review run works.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) are for
  people and agents working on elek.

## License

MIT. Built on [Pi](https://github.com/earendil-works/pi).
