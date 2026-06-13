# Workflow examples

## Auto-review on every push (recommended starting point)

```yaml
# .github/workflows/elek.yml
name: elek
on:
  pull_request: { types: [opened, synchronize, reopened] }

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: elek-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6.0.3
        with: { fetch-depth: 0 }
      - uses: selimozten/elek@v1
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          provider: deepseek
          model: deepseek-v4-pro
          thinking: high
```

## Comment-triggered review

```yaml
on:
  issue_comment: { types: [created] }

jobs:
  review:
    if: github.event.issue.pull_request
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6.0.3
        with: { fetch-depth: 0 }
      - uses: selimozten/elek@v1
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          provider: deepseek
          model: deepseek-v4-pro
```

Trigger by commenting `@pi review the auth flow` on a PR. The text after `@pi` becomes the prompt.

## Dual-model review (cross-validation)

Run two cheap models in parallel; each addresses the other's findings on the next push.

```yaml
on:
  pull_request: { types: [opened, synchronize, reopened] }

permissions: { contents: read, pull-requests: write, issues: write }

concurrency:
  group: elek-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  deepseek:
    name: deepseek-v4-pro
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6.0.3
        with: { fetch-depth: 0 }
      - uses: selimozten/elek@v1
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          provider: deepseek
          model: deepseek-v4-pro
          thinking: high
          branch_prefix: elek/deepseek/

  kimi:
    name: openrouter-kimi-k2.7-code
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6.0.3
        with: { fetch-depth: 0 }
      - uses: selimozten/elek@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          provider: openrouter
          model: moonshotai/kimi-k2.7-code
          thinking: high
          branch_prefix: elek/kimi/
```

## Review + propose fixes

The model can push fixes to an `elek/*` branch when something is mechanical (rename, add missing test, simple refactor).

```yaml
permissions: { contents: write, pull-requests: write, issues: write }

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6.0.3
        with: { fetch-depth: 0 }
      - uses: selimozten/elek@v1
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          provider: deepseek
          model: deepseek-v4-pro
          mode: review+edit
          prompt: |
            Review this PR. For mechanical issues (typos, obvious bugs,
            missing imports), make a focused file edit. elek will commit and
            push the generated branch after the run succeeds. For design
            questions, just review.
```

## Issue triage

```yaml
on:
  issues: { types: [opened] }

permissions: { issues: write }

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v6.0.3
      - uses: selimozten/elek@v1
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          provider: deepseek
          prompt: |
            Triage this issue:
            - Bug, feature request, or question?
            - Severity: critical / major / minor
            - Affected component (if a bug)
            - Repro steps clear? If not, ask.
            - Suggested next step.
```

## Skip docs-only changes

```yaml
on:
  pull_request:
    types: [opened, synchronize]
    paths-ignore:
      - "**/*.md"
      - "docs/**"
      - "LICENSE"
```

## Restrict to specific reviewers

```yaml
- uses: selimozten/elek@v1
  with:
    deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    actor_filter: "alice,bob,charlie"
```

Or allow specific bots:

```yaml
- uses: selimozten/elek@v1
  with:
    deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    allowed_bots: "renovate[bot],dependabot[bot]"
```

## Custom prompt

```yaml
- uses: selimozten/elek@v1
  with:
    deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    prompt: |
      Review this PR with a focus on Postgres query performance:
      1. Look for N+1 patterns
      2. Check for missing indexes implied by new WHERE clauses
      3. Flag transactions that hold locks across HTTP calls
      4. Note any new SELECT * queries
      Reference exact file paths and line numbers.
```

## Path-filtered review

Use GitHub's workflow path filters when a repository needs different review
prompts for different parts of the tree. For example, a TypeScript-focused
workflow can run only when TypeScript-related files change:

```yaml
on:
  pull_request:
    types: [opened, synchronize]
    paths:
      - "**/*.ts"
      - "**/*.tsx"
      - "package.json"
      - "tsconfig.json"

jobs:
  ts-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6.0.3
        with: { fetch-depth: 0 }
      - uses: selimozten/elek@v1
        with:
          deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          prompt: "TypeScript-focused review: types, null handling, async correctness, exhaustiveness."
```

## Pin the action

For production, pin to a specific commit SHA rather than `@v1`:

```yaml
- uses: selimozten/elek@a1b2c3d4e5f6...   # specific SHA
```

Renovate / Dependabot can keep this updated.
