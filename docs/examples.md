# Workflow examples

Each recipe changes the workflow from the [README](../README.md#manual-workflow).
Only the changed parts are shown.

## Use a different provider

Set `provider`, `model`, and the matching key input:

```yaml
- uses: selimozten/elek@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    provider: openrouter
    model: moonshotai/kimi-k2.7-code
```

```yaml
- uses: selimozten/elek@v1
  with:
    opencode_api_key: ${{ secrets.OPENCODE_API_KEY }}
    provider: opencode-go
    model: deepseek-v4.1-flash
```

## Review with two models

Run one job per model. Each model keeps its own tracking comment, so the two
reviews do not overwrite each other. Two models cost twice as much, so add the
second one only when it finds issues the first one misses.

```yaml
jobs:
  deepseek:
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

  kimi:
    if: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6.0.3
        with:
          fetch-depth: 0
      - uses: selimozten/elek@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          provider: openrouter
          model: moonshotai/kimi-k2.7-code
```

## Focus the review request

`prompt` replaces the default request. elek still applies its safety rules,
review lenses, and response format.

```yaml
- uses: selimozten/elek@v1
  with:
    deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    provider: deepseek
    model: deepseek-v4-pro
    prompt: |
      Focus on src/auth/ and the database migrations. Flag any query that
      does not filter by tenant.
```

For rules that apply to every PR, prefer `instructions` in `.elek.yml`. Once
the file is on the base branch, elek loads it from there, so a PR cannot change
it.

## Keep the review advisory

Let the job fail without blocking the PR when the provider is down or out of
quota:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    continue-on-error: true
```

## Cap the run time

Stop the model run after 10 minutes and post a failure note instead of waiting
for the job timeout:

```yaml
- uses: selimozten/elek@v1
  with:
    deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    provider: deepseek
    run_timeout_seconds: 600
```

## Skip docs-only changes

Use path filters only on advisory workflows. A required check that never runs
blocks branch protection.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths-ignore:
      - "**/*.md"
      - "docs/**"
```

## Post a PR review without a tracking comment

```yaml
- uses: selimozten/elek@v1
  with:
    deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    provider: deepseek
    sticky_comment: false
```

elek then posts one PR review per run and no live progress comment.

## Pin the Action

`selimozten/elek@v1` follows the latest v1 release. To pin an exact release,
use its tag or commit SHA:

```yaml
- uses: selimozten/elek@v1.3.0
```
