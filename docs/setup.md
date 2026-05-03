# Setup Guide

## Requirements

- A GitHub repository
- An API key for at least one AI provider (Anthropic, OpenAI, Google, etc.)
- Repository admin access (to add secrets)

## Step 1: Add API key as secret

Go to your repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Add your API key:

| Provider | Secret name | Example value |
|----------|------------|---------------|
| Anthropic | `ANTHROPIC_API_KEY` | `sk-ant-...` |
| OpenAI | `OPENAI_API_KEY` | `sk-...` |
| Google | `GOOGLE_API_KEY` | `AIza...` |
| DeepSeek | `DEEPSEEK_API_KEY` | `sk-...` |
| Groq | `GROQ_API_KEY` | `gsk_...` |
| Mistral | `MISTRAL_API_KEY` | `...` |
| xAI | `XAI_API_KEY` | `...` |
| OpenRouter | `OPENROUTER_API_KEY` | `sk-or-...` |

## Step 2: Create workflow file

Create `.github/workflows/elek.yml`:

```yaml
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
        with:
          fetch-depth: 0  # Recommended for accurate git diffs
      - uses: selimozten/elek@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Step 3: Test

1. Open a PR or create an issue
2. Comment `@pi hello` on the PR/issue
3. elek will respond with a comment

## Trigger methods

### 1. @pi mention (interactive)

Comment `@pi` followed by your request on any PR or issue:

```
@pi review this code for security vulnerabilities
@pi explain how the auth module works
@pi fix the bug in the payment handler
```

### 2. Automatic on PR open/sync

Add a `prompt` input and the action runs automatically:

```yaml
- uses: selimozten/elek@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: |
      Review this PR thoroughly. Check for:
      - Correctness and logic errors
      - Security issues
      - Performance problems
      - Missing tests
```

### 3. Automatic on issue open

```yaml
- uses: selimozten/elek@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: |
      Analyze this issue and suggest:
      - Root cause (if a bug)
      - Affected components
      - Recommended approach
```

### 4. Scheduled runs

```yaml
on:
  schedule:
    - cron: "0 9 * * 1-5"
```

## Git configuration

For PR reviews that include diffs, use `fetch-depth: 0`:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

## Permissions explained

```yaml
permissions:
  contents: write       # Create branches, commit changes
  pull-requests: write  # Post PR reviews and comments
  issues: write         # Post issue comments
```

Read-only mode:

```yaml
permissions:
  pull-requests: write
  issues: write
```

## Security notes

### API key isolation

Each provider key is a separate input. Only the key for the provider you're using needs to be set. pi never sees keys for other providers.

### Actor filtering

By default, only human users can trigger (accounts ending in `[bot]` are excluded). To allow bots:

```yaml
with:
  allowed_bots: "dependabot[bot],renovate[bot]"
```

To restrict to specific users:

```yaml
with:
  actor_filter: "alice,bob,charlie"
```

### Tool restrictions

Use `tools` to restrict what pi can do:

```yaml
with:
  tools: "read,grep,find,ls"  # Read-only
```

## Troubleshooting

### pi binary not found

The action adds `node_modules/.bin` to PATH. If pi isn't found, check the action logs.

### API key not recognized

- Verify the secret name matches the input name
- Verify the secret is added to the repository
- Check workflow references correct secret: `${{ secrets.ANTHROPIC_API_KEY }}`

### Empty PR diff

Make sure `actions/checkout` uses `fetch-depth: 0`.

### Trigger not firing

- Comment must contain `@pi` (or custom `trigger_phrase`)
- Automatic triggers need non-empty `prompt` input
- Check actor is allowed (not a bot, or in `allowed_bots`)
