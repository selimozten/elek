# elek 🧲

**Model-agnostic AI code review for GitHub.** Sift through PRs and issues with [pi coding agent](https://github.com/badlogic/pi-mono).

Ask elek to review PRs, triage issues, or answer questions — directly from GitHub. Works with **any AI provider** pi supports: Anthropic, OpenAI, Google Gemini, AWS Bedrock, DeepSeek, Groq, Mistral, xAI, OpenRouter, and more.

```yaml
# .github/workflows/elek.yml
on:
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize]

jobs:
  elek:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Why elek?

| Feature | elek | Claude Code Action |
|---------|------|-------------------|
| **Provider lock-in** | None — any provider | Anthropic only |
| **Models** | Claude, GPT, Gemini, DeepSeek, Groq, Mistral, xAI... | Claude only |
| **API surface** | Standard env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) | Anthropic-specific + Bedrock + Vertex + Foundry |
| **Dependencies** | Node.js + tsx | Bun + Claude CLI installer |
| **MCP servers** | Not needed | 4 built-in MCP servers |
| **Source files** | 8 TypeScript modules | 50+ modules |
| **Complexity** | One orchestrator, clean modules | 50+ modules, 2 action types |

## Quickstart

### 1. Create a workflow

```yaml
# .github/workflows/elek.yml
name: elek

on:
  issue_comment:
    types: [created]
  issues:
    types: [opened]
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  elek:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 2. Add your API key

Go to **Settings → Secrets and variables → Actions** and add your key:

- `ANTHROPIC_API_KEY` for Claude
- `OPENAI_API_KEY` for GPT-4o
- `GOOGLE_API_KEY` for Gemini
- etc.

### 3. Use it

Comment `@pi review this` on any PR or issue. elek will analyze and respond.

## Configuration

### Model selection

```yaml
- uses: selimozten/elek@v1
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    provider: openai
    model: gpt-4o
    thinking: high
```

### Multi-provider

```yaml
# Use Claude for PR review
- uses: selimozten/elek@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    provider: anthropic
    model: claude-sonnet-4-5

# Use GPT-4o for issue triage
- uses: selimozten/elek@v1
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    provider: openai
    model: gpt-4o
```

### All inputs

| Input | Default | Description |
|-------|---------|-------------|
| `trigger_phrase` | `@pi` | Phrase that triggers elek in comments |
| `provider` | `anthropic` | AI provider |
| `model` | (provider default) | Model identifier |
| `thinking` | `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `prompt` | (from comment) | Explicit prompt (bypasses trigger detection) |
| `system_prompt` | (pi default) | System prompt override |
| `max_turns` | `20` | Max conversation turns |
| `tools` | `read,write,edit,bash,grep,find,ls` | Allowed tools |
| `base_branch` | (repo default) | Base branch for PRs |
| `branch_prefix` | `pi/` | Prefix for branches elek creates |
| `actor_filter` | (empty) | Allowed usernames (empty = all humans) |
| `allowed_bots` | (empty) | Allowed bots (`*` for all) |
| `sticky_comment` | `true` | Update one comment vs. create new ones |

### API key inputs

| Input | Env var pi uses |
|-------|----------------|
| `anthropic_api_key` | `ANTHROPIC_API_KEY` |
| `openai_api_key` | `OPENAI_API_KEY` |
| `google_api_key` | `GOOGLE_API_KEY` |
| `deepseek_api_key` | `DEEPSEEK_API_KEY` |
| `groq_api_key` | `GROQ_API_KEY` |
| `mistral_api_key` | `MISTRAL_API_KEY` |
| `xai_api_key` | `XAI_API_KEY` |
| `openrouter_api_key` | `OPENROUTER_API_KEY` |

For AWS Bedrock, set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` as job-level env vars.
For Google Vertex, set `GOOGLE_APPLICATION_CREDENTIALS` and `ANTHROPIC_VERTEX_PROJECT_ID`.

## How it works

```
GitHub Event (PR, issue, comment)
    │
    ▼
┌─────────────────────────────┐
│ 1. Parse GitHub context     │  ← Who triggered? What's the PR number?
├─────────────────────────────┤
│ 2. Detect trigger           │  ← @pi mention? Label? Explicit prompt?
├─────────────────────────────┤
│ 3. Fetch data               │  ← PR diff, issue body, comments
├─────────────────────────────┤
│ 4. Build prompt             │  ← Structured prompt with full context
├─────────────────────────────┤
│ 5. Run pi (print mode)      │  ← pi -p --provider X --model Y @prompt.md
├─────────────────────────────┤
│ 6. Post results             │  ← Comment, PR review, or branch push
└─────────────────────────────┘
```

## Architecture

```
action.yml → npm install → run.ts
    ├── Parse context (context.ts)
    ├── Detect trigger (trigger.ts)
    ├── Fetch data (data.ts)
    ├── Run pi CLI (pi.ts)
    ├── Post results (comments.ts)
    ├── Git ops (git.ts)
    └── 8 TypeScript modules
```

## Workflow examples

### PR review on @pi mention

```yaml
on:
  issue_comment:
    types: [created]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
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

### Automatic PR review on open/sync

```yaml
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Review this PR for:
            1. Bugs and logic errors
            2. Security vulnerabilities
            3. Performance issues
            4. Code style problems
            Provide specific, actionable feedback with line references.
```

### Issue triage bot

```yaml
on:
  issues:
    types: [opened]

jobs:
  triage:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: selimozten/elek@v1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          provider: openai
          model: gpt-4o
          prompt: |
            Analyze this issue. Determine if it's a bug, feature request, or question.
            Suggest severity, affected component, and next steps. Be concise.
```

### Read-only analysis

```yaml
- uses: selimozten/elek@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    tools: read,grep,find,ls  # Read-only — no code changes
    prompt: "Analyze this PR for security issues."
```

### Scheduled maintenance

```yaml
on:
  schedule:
    - cron: "0 9 * * 1"  # Every Monday 9am

jobs:
  maintain:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Review the repo: stale issues, ready PRs, doc gaps, dependency updates.
```

## Permissions

```yaml
permissions:
  contents: write       # For creating branches, commits
  pull-requests: write  # For posting PR reviews
  issues: write         # For posting comments
```

Read-only mode (no code changes):

```yaml
permissions:
  pull-requests: write
  issues: write
```

## Supported events

- `pull_request` (opened, synchronize, reopened)
- `issues` (opened)
- `issue_comment` (created)
- `pull_request_review` (submitted)
- `pull_request_review_comment` (created)

## License

MIT

## Credits

Built on [pi coding agent](https://github.com/badlogic/pi-mono) by Mario Zechner.  
Architecture inspired by [Claude Code Action](https://github.com/anthropics/claude-code-action), stripped down and made model-agnostic.
