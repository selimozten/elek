# Workflow Examples

## Basic PR Review (Comment Trigger)

```yaml
# .github/workflows/elek-review.yml
name: elek-review

on:
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  review:
    if: github.event.issue.pull_request
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          provider: anthropic
          model: claude-sonnet-4-5
          thinking: high
```

Usage: Comment `@pi review this PR for bugs` on a pull request.

---

## Automatic PR Review

```yaml
# .github/workflows/elek-auto-review.yml
name: elek-auto-review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          provider: anthropic
          model: claude-sonnet-4-5
          thinking: high
          prompt: |
            Review this PR. Provide:
            1. Summary of changes
            2. Bugs, logic errors, or edge cases
            3. Security concerns
            4. Performance implications
            5. Style violations
            Be specific. Reference files and line numbers.
```

---

## Issue Triage (OpenAI GPT-4o)

```yaml
# .github/workflows/elek-triage.yml
name: elek-triage

on:
  issues:
    types: [opened]

permissions:
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: selimozten/elek@v1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          provider: openai
          model: gpt-4o
          thinking: low
          prompt: |
            Triage this issue concisely:
            Type: bug | feature | question | docs
            Priority: critical | high | medium | low
            Component: which part of the codebase?
            Assessment: one sentence
            Action: label, assign, close, or investigate
```

---

## Multi-Model Pipeline

```yaml
# .github/workflows/elek-multi.yml
name: elek-multi

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      # Fast scan with Haiku
      - name: Quick scan
        uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          provider: anthropic
          model: claude-haiku-4-5
          thinking: off
          prompt: "Quick scan: any obvious issues? One sentence summary."

      # Deep review with Sonnet
      - name: Deep review
        uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          provider: anthropic
          model: claude-sonnet-4-5
          thinking: high
          prompt: |
            Deep review. Check: logic, edge cases, security, performance, test gaps.
```

---

## Read-Only Code Analysis

```yaml
# .github/workflows/elek-analyze.yml
name: elek-analyze

on:
  pull_request:
    types: [opened]

permissions:
  pull-requests: write
  # No contents: write — prevent code changes

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          tools: read,grep,find,ls
          prompt: "Analyze this PR. Read-only access. Focus on quality and security."
```

---

## Custom Trigger Phrase

```yaml
- uses: selimozten/elek@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    trigger_phrase: "@bot"
```

---

## Cross-Provider Fallback

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      # Primary: Claude
      - name: Review with Claude
        id: claude
        continue-on-error: true
        uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          provider: anthropic
          model: claude-sonnet-4-5

      # Fallback: GPT-4o
      - name: Review with GPT-4o
        if: steps.claude.outcome == 'failure'
        uses: selimozten/elek@v1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          provider: openai
          model: gpt-4o
```

---

## Scheduled Maintenance

```yaml
name: elek-maintenance

on:
  schedule:
    - cron: "0 9 * * 1"  # Every Monday 9am UTC

permissions:
  issues: write
  pull-requests: write

jobs:
  maintain:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          provider: anthropic
          model: claude-sonnet-4-5
          prompt: |
            Review the repo and report:
            1. Stale issues (>30 days, no activity)
            2. PRs ready to merge (approved, CI passing)
            3. Documentation gaps from recent code changes
            4. Dependency updates needed
```
