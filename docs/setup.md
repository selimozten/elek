# Setup guide

## Requirements

- A GitHub repository
- One provider API key (DeepSeek, OpenRouter, OpenAI, Anthropic, ...)
- Repo admin access (to add secrets)

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

## 2. Add the workflow

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
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6.0.3
        with: { fetch-depth: 0 }   # required for accurate PR diffs
      - uses: selimozten/elek@v1
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          provider: deepseek
          model: deepseek-v4-pro
          thinking: high
```

## 3. Test it

1. Open a PR or push a commit. The review should appear within ~3 minutes.
2. To trigger from a comment: write `@pi review the auth flow` on any PR or issue.

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
```

| `review_strategy` | Behavior |
|---|---|
| `solo` | One model reviews and posts. |
| `crosscheck` | Risk + design lenses run read-only, then a final validator posts. |
| `council` | Risk + design + tests + operations lenses run read-only, then a final validator posts. |

Candidate reviewers cannot post comments. They run without MCP access; only the
final validator can call elek's review tools.

Non-solo strategies currently require `mode: review`. If `crosscheck` or
`council` is configured with `review+edit` or `agent`, elek runs a solo review
and logs a warning.

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
