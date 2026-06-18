# Self-hosted setup guide

This guide covers the self-hosted GitHub Action runtime. The hosted GitHub App
is the planned primary install path for normal product onboarding; the Action
remains available for BYOK, auditable runs, and custom workflow control.

## Requirements

- A GitHub repository
- One provider API key (DeepSeek, OpenRouter, OpenAI, Anthropic, ...)
- Repo admin access (to add secrets)

## Fast path

From your repository root:

```bash
npx --package github:selimozten/elek elek-init --provider deepseek
```

This creates:

- `.github/workflows/elek.yml`
- `.elek.yml`

Then add the `DEEPSEEK_API_KEY` repository secret and open a PR. This creates
the same review engine behavior the hosted App will build on, but runs inside
your own GitHub Actions workflow.

Useful variants:

```bash
npx --package github:selimozten/elek elek-init --provider openrouter --model moonshotai/kimi-k2.7-code
npx --package github:selimozten/elek elek-init --strategy crosscheck --max-cost-usd 0.05
npx --package github:selimozten/elek elek-init --provider anthropic \
  --model claude-sonnet-4-6 --secret ANTHROPIC_API_KEY
npx --package github:selimozten/elek elek-init --no-config
```

`elek-init` refuses to overwrite existing files unless you pass `--force`.

## 1. Add the API key

`Settings → Secrets and variables → Actions → New repository secret`. Use the secret name that matches the input on the action:

| Provider | Secret name |
|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GOOGLE_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

For Bedrock: set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` as job-level env. For Vertex: `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_PROJECT_ID`.

## 2. Add the workflow manually

`.github/workflows/elek.yml`:

```yaml
name: elek

on:
  pull_request: { types: [opened, synchronize, reopened] }
  issue_comment: { types: [created] }
  issues: { types: [opened] }

permissions:
  contents: read           # blocks merge entirely
  pull-requests: write     # post review comments
  issues: write            # post tracking comment

concurrency:
  group: elek-${{ github.event_name }}-${{ github.event.pull_request.number || github.event.issue.number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    if: ${{ github.event_name != 'issue_comment' || !endsWith(github.actor, '[bot]') }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6.0.3
        with: { fetch-depth: 0 }   # required for accurate PR diffs
      - uses: selimozten/elek@v1
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          provider: deepseek
          model: deepseek-v4-pro
          thinking: high
          run_timeout_seconds: 600
```

## 3. Test it

1. Open a PR or push a commit. The review should appear within ~3 minutes.
2. The final comment includes an estimated token/cost line.
3. To trigger from a comment: write `@pi review the auth flow` on any PR or issue.

## Model and reasoning levels

Use current provider model IDs directly. Common review choices:

| Provider | Model | Notes |
|---|---|---|
| DeepSeek | `deepseek-v4-pro` | Low-cost primary reviewer |
| OpenRouter | `moonshotai/kimi-k2.7-code` | Independent second reviewer |
| OpenAI | `gpt-5.5` | Strong reasoning reviewer or validator |
| Anthropic | `claude-sonnet-4-6` | Balanced premium validator |
| Anthropic | `claude-opus-4-8` | Highest-capability validator for critical PRs |

`thinking` uses pi's portable levels: `off`, `minimal`, `low`, `medium`,
`high`, and `xhigh`. Provider adapters map those to native effort controls
where needed; for Claude models, the top effort maps to Claude's native `max`
reasoning effort when supported.

## Triggers

| Trigger | Behavior |
|---|---|
| `pull_request.opened` / `synchronize` | Auto-review every push |
| `issue_comment` containing `@pi …` | Acts on the comment after the trigger phrase |
| `issues.opened` | Optional triage when paired with a `prompt:` |
| Labels (configured separately) | `@pi` label on an issue triggers a run |

Customize the trigger phrase via `trigger_phrase: "@bot"`.

## Modes

```yaml
- uses: selimozten/elek@v1
  with:
    deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    mode: review        # or review+edit, or agent
```

| `mode` | Tools | Inline comments | Edits | When to use |
|---|---|---|---|---|
| `review` (default) | `read,grep,find,ls,mcp` | ✓ | ✗ | All review-only workflows |
| `review+edit` | + `write,edit` | ✓ | pushes to `elek/*` branch | "Review and propose fixes" |
| `agent` | + `bash` | ✗ (legacy) | ✓ | Trusted automation, no MCP |

`review+edit` does not give the model shell access. The model can make file
edits with write/edit tools; elek stages, commits, and pushes those changes to
the generated branch after the review run succeeds.

## Review strategies

`review_strategy` controls how many independent review passes run before the
visible review is posted:

```yaml
- uses: selimozten/elek@v1
  with:
    deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    provider: deepseek
    model: deepseek-v4-pro
    review_strategy: crosscheck
    review_models: deepseek/deepseek-v4-pro,openrouter/moonshotai/kimi-k2.7-code
    validator_model: deepseek/deepseek-v4-pro
    max_cost_usd: "0.05"
```

| `review_strategy` | Behavior |
|---|---|
| `solo` | One model reviews and posts. |
| `crosscheck` | Risk + design lenses run read-only, then a final orchestrator validates and posts. |
| `council` | Risk + design + tests + operations lenses run read-only, then a final orchestrator validates and posts. |

Candidate reviewers cannot post comments. They run without MCP access; only the
final orchestrator can call elek's review tools.

Non-solo strategies currently require `mode: review`. If `crosscheck` or
`council` is configured with `review+edit` or `agent`, elek runs a solo review
and logs a warning.

## Repo config

Use `.elek.yml` when every workflow in the repository should share the same
review policy. This keeps workflow YAML small and lets teams tune review
behavior alongside the code.

```yaml
review_strategy: crosscheck
review_models: deepseek/deepseek-v4-pro,openrouter/moonshotai/kimi-k2.7-code
validator_model: deepseek/deepseek-v4-pro
cost_rates: openrouter/moonshotai/kimi-k2.7-code=0.95:4.00,deepseek/deepseek-v4-pro=0.25:1.00
max_cost_usd: 0.05
max_council_changed_lines: 1200
max_crosscheck_changed_lines: 3000
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

Supported keys:

| Key | Behavior |
|---|---|
| `review_strategy` | Default strategy when the workflow input is unset |
| `review_models` | Default reviewer model list |
| `validator_model` | Default final orchestrator/validation model |
| `cost_rates` | Default price overrides as `model=inputPerMillion:outputPerMillion` |
| `max_cost_usd` | Soft cap; downgrade multi-lens reviews when known input-side estimates already exceed it |
| `max_council_changed_lines` | Changed-line cap before `council` downgrades; `0` disables |
| `max_crosscheck_changed_lines` | Changed-line cap before `crosscheck` downgrades; `0` disables |
| `severity_threshold` | Prompt-level reviewer threshold: `critical`, `important`, or `minor` |
| `knowledge_paths` | Repo-local docs or directories to include as bounded review context |
| `ignore_paths` | Skip a finding only when all of its evidence lies inside these paths; still surface issues that leak impact outside them |
| `instructions` | Extra repo-specific review policy inserted into every prompt |

Workflow inputs override `.elek.yml` when explicitly set. To disable config
loading, set `config_path: none`, `off`, or `false`. Severity thresholds and
ignore paths are review instructions, not a server-side comment filter. If an
existing config file has malformed YAML, elek fails the run instead of silently
dropping repo policy.

Security note: on pull requests, elek loads policy fields (`review_strategy`,
`review_models`, `validator_model`, `cost_rates`, `max_cost_usd`,
changed-line guards, and `severity_threshold`) from the base branch when
available. Guidance fields (`knowledge_paths`, `ignore_paths`, and `instructions`) come from the
checked-out branch, so contributors can propose review guidance changes without
controlling cost or severity policy. Each run logs the loaded config source
plus effective strategy/model/severity choices.
If `knowledge_paths` is unset, elek automatically tries `AGENTS.md`,
`CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, and `docs/adr`. Files are loaded
only from inside the workspace and are capped before they enter the prompt.
If elek cannot resolve a PR comment trigger's actual base branch, it skips
base-branch policy loading for that run instead of guessing from the default
branch; policy fields from the checked-out workspace are not used as a
fallback. For `issue_comment` triggers, "checked-out branch" is whatever the
workflow checked out, usually the default branch unless the workflow explicitly
checks out the PR head.

## Cost visibility

Cost reporting is on by default. elek estimates tokens from prompt/output text
and applies known model price hints where available. The final review comment
and action outputs include:

- `cost_usd`
- `input_tokens`
- `output_tokens`
- `review_summary_path`
- `review_summary_json`

`review_summary_path` points to `elek-review-summary.json` in the runner temp
directory. The JSON includes total duration, requested/executed strategy,
model labels, parsed findings, per-model token/cost estimates, pricing source,
and inline comment counts. Upload that path as an artifact in your workflow
when you want to compare model quality, speed, and cost across PRs.

After the implementation agent or maintainer has handled the review, create a
finding feedback file and merge it back into the saved summary:

```bash
npx --package github:selimozten/elek elek-feedback --template artifacts/pr-42/elek-review-summary.json > feedback.json
npx --package github:selimozten/elek elek-feedback --apply feedback.json artifacts/pr-42/elek-review-summary.json > artifacts/pr-42/adjudicated-summary.json
```

Use `accepted`, `partial`, `rejected`, or `unreviewed` for each finding and a
`0-5` integer point score. This is the agent-native quality signal: the agent
doing the main code change can mark which findings were real, useful, or false
positives, then analytics can compare models on accepted findings and average
score. Applying feedback is a replacement step: findings omitted from the
feedback file are reset to `unreviewed`.

Aggregate saved summaries by strategy, model, or repository:

```bash
npx --package github:selimozten/elek elek-analytics --group-by strategy artifacts/*/adjudicated-summary.json
```

Compare a baseline artifact set against a current artifact set when you want
to catch trend regressions before changing default models or strategies:

```bash
npx --package github:selimozten/elek elek-analytics --group-by model \
  --baseline artifacts/before/*/adjudicated-summary.json \
  --current artifacts/after/*/adjudicated-summary.json
```

Use `--json` when sending aggregate or comparison reports to dashboards,
release notes, or scheduled quality checks.

For models without built-in price hints, pass your provider's current USD price
per 1M input/output tokens:

```yaml
- uses: selimozten/elek@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    provider: openrouter
    model: moonshotai/kimi-k2.7-code
    show_cost: true
    cost_rates: openrouter/moonshotai/kimi-k2.7-code=0.95:4.00
    max_cost_usd: "0.10"
    max_council_changed_lines: 1200
    max_crosscheck_changed_lines: 3000
```

`max_cost_usd` is conservative. elek only downgrades a multi-lens strategy
when the known prompt/input-side estimate already exceeds the cap before
output tokens. Add `cost_rates` for custom models so the guard can enforce it.
Changed-line guards run first: by default, `council` downgrades above 1,200
changed diff lines and `crosscheck` downgrades above 3,000. Set either guard
to `0` to disable it.

Disable the visible comment/log line while keeping outputs available:

```yaml
show_cost: false
```

## Model evaluation

Save review summary artifacts from a fixed set of seeded PRs, then score them
locally:

```bash
npx --package github:selimozten/elek elek-eval --suite review-benchmark.yml artifacts/*/elek-review-summary.json
```

To create the first editable case from a saved summary:

```bash
npx --package github:selimozten/elek elek-benchmark --id auth-regression artifacts/auth/elek-review-summary.json > review-benchmark.yml
```

Minimal benchmark suite:

```yaml
version: 1
cases:
  - id: auth-regression
    repository: owner/repo
    number: 42
    expected_findings:
      - id: tenant-bypass
        min_severity: critical
        keywords: [tenant, session, bypass]
    max_false_positives: 0
```

Each summary is matched to a case by `repository` and PR/issue number, or you
can pass `--case <id>` when scoring one case at a time. The evaluator reports
recall, precision, false positives, duration, and cost; `--json` emits the
same data for dashboards. Treat generated benchmark cases as drafts and edit
their expected findings before using them as release gates.

## Permissions

```yaml
permissions:
  contents: read           # blocks merge — model can't push to base
  pull-requests: write
  issues: write
```

For `mode: review+edit` (pushing to `elek/*` branches), upgrade `contents: write`. The model still cannot approve or merge — those code paths don't exist in the MCP server.

## Comment identity

With the default `github_token`, GitHub displays elek comments as
`github-actions[bot]`. Actions cannot override that avatar.

To show an elek avatar in the PR timeline, pass `github_token` from a dedicated
GitHub App or bot account token. The default `GITHUB_TOKEN` remains the safest
zero-setup option; elek still renders its mark and name inside the tracking and
final review comments.

## Actor filtering

By default, only humans trigger (any actor matching `*[bot]` is excluded):

```yaml
allowed_bots: "renovate[bot],dependabot[bot]"   # specific bots
allowed_bots: "*"                                 # all bots
actor_filter: "alice,bob"                         # specific humans only
```

## Concurrency

Cancel stale runs when a new push lands:

```yaml
concurrency:
  group: elek-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

## Path filters (skip docs-only churn)

Use path filters on advisory workflows only. Required checks should run on
every PR so branch protection never waits on a skipped status check.

```yaml
on:
  pull_request:
    types: [opened, synchronize]
    paths-ignore:
      - "**/*.md"
      - "docs/**"
      - "LICENSE"
```

## Troubleshooting

### Comment stuck on "analyzing…" with no progress

The most common cause: `pi --mode json` was hanging on stdin. Make sure you're on `selimozten/elek@v1` or later — older revs had this bug. If on latest and still stuck, check the run logs for the `Command:` line and confirm it doesn't mention `--no-extensions` (it shouldn't in MCP modes).

### Empty PR diff

`actions/checkout@v6.0.3` defaults to a shallow clone. Use `fetch-depth: 0`.

### "Tool not found" errors in the review

The model called `mcp({tool: "update_tracking_comment", …})` without the server prefix. Pi-mcp-adapter exposes ours as `elek_review_update_tracking_comment`. The prompt explains this; if you see this often, the model may need a stronger prompt or higher thinking level.

### `403` on inline comments for fork PRs

`pull_request` from a fork only gets a read-only `GITHUB_TOKEN`. Use `pull_request_target` cautiously (it has the base repo's secrets) or accept that reviews on fork PRs need the comment author to be a member.

### Review never posts

Check `permissions:` in your workflow. `pull-requests: write` is required for the inline comments and `issues: write` for the tracking comment. With both omitted, the action's API calls 403 silently.

### Multiple comments instead of one

The dedup key is the model signature (`<!-- elek-bot:provider/model -->`). If you change `provider` or `model` mid-PR, the bot creates a new comment for the new identity. That's intentional — different models, different tracking.
