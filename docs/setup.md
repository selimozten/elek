# Set up elek

This guide adds elek to a repository and covers the problems people hit
first. The [README](../README.md) has the full input, config, and output
reference.

## Requirements

- A GitHub repository with Actions enabled.
- An API key for a model provider that [Pi](https://github.com/earendil-works/pi)
  supports.

## Generate the workflow

From your repository root, run:

```bash
npx --package github:selimozten/elek elek-init --provider deepseek
```

`elek-init` writes `.github/workflows/elek.yml` and `.elek.yml`. It refuses to
overwrite existing files unless you pass `--force`. These variants are common:

```bash
npx --package github:selimozten/elek elek-init --provider anthropic --model claude-sonnet-4-6
npx --package github:selimozten/elek elek-init --provider openai --secret MY_OPENAI_KEY
npx --package github:selimozten/elek elek-init --no-config
```

`--provider` accepts `deepseek`, `openrouter`, `together`, `opencode-go`,
`anthropic`, `openai`, and `google`. For any other Pi provider, copy the
manual workflow from the README and change `provider`, `model`, and the key
input.

## Add the API key

In the repository, open **Settings**, then **Secrets and variables**, then
**Actions**, and add a repository secret. Use the name the workflow passes to
the key input:

| Provider | Secret | Input |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek_api_key` |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic_api_key` |
| OpenAI | `OPENAI_API_KEY` | `openai_api_key` |
| Google | `GOOGLE_API_KEY` | `google_api_key` |
| Groq | `GROQ_API_KEY` | `groq_api_key` |
| Mistral | `MISTRAL_API_KEY` | `mistral_api_key` |
| Together | `TOGETHER_API_KEY` | `together_api_key` |
| xAI | `XAI_API_KEY` | `xai_api_key` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter_api_key` |
| OpenCode Zen or Go | `OPENCODE_API_KEY` | `opencode_api_key` |

For Amazon Bedrock, set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and
`AWS_SECRET_ACCESS_KEY` as job-level `env`. For Vertex, set
`GOOGLE_APPLICATION_CREDENTIALS` and `ANTHROPIC_VERTEX_PROJECT_ID`.

## Pick a model

Use the provider's model ID. These are common review choices:

| Provider | Model |
|---|---|
| DeepSeek | `deepseek-v4-pro` |
| OpenRouter | `moonshotai/kimi-k2.7-code` |
| OpenAI | `gpt-5.5` |
| Anthropic | `claude-sonnet-4-6` |
| Anthropic | `claude-opus-4-8` |

`thinking` takes Pi's levels: `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max`. Pi maps each level to the provider's own reasoning
setting.

## Test it

Commit the workflow and open a non-draft pull request. On each run, elek:

1. Posts a tracking comment with a progress checklist.
2. Runs one read-only Pi session on the diff.
3. Replaces the checklist with the review and a token usage line.
4. Posts inline comments on the changed lines it found issues in.

On later pushes, elek reuses its tracking comment and skips inline findings it
already posted.

## Comment identity

With the default `github_token`, comments come from `github-actions[bot]`.
GitHub does not let an Action change that name or avatar.

To post as a GitHub App or bot account, pass its token as `github_token`. Then
set `ELEK_TRACKING_COMMENT_AUTHORS` to that account's login in the job `env`.
elek only reuses tracking comments written by these logins, so a PR author
cannot plant a fake one.

```yaml
jobs:
  review:
    env:
      ELEK_TRACKING_COMMENT_AUTHORS: my-review-bot[bot]
```

## Troubleshooting

### The run was skipped

The `summary` output and the log say why. elek skips:

- events other than `pull_request` opened, synchronize, reopened, or
  ready_for_review;
- draft pull requests;
- runs triggered by bots or by users who are not repository owners, members,
  or collaborators;
- pull requests from forks, which get no secrets.

### "Authoritative PR diff unavailable"

elek builds the diff from the checkout and falls back to the GitHub API. Check
out with `fetch-depth: 0`.

### "No API key for provider ..."

The key input is empty on a same-repository run. Add the repository secret and
pass it with the matching input, for example
`deepseek_api_key: ${{ secrets.DEEPSEEK_API_KEY }}`. elek checks the key
before it posts anything.

### The review never posts

Check the workflow `permissions`. elek needs `pull-requests: write` for the
review and inline comments and `issues: write` for the tracking comment.

### The comment stays on "analyzing"

The model is still working, or the provider is slow. Open the run log. elek logs
each Pi turn with its duration and token counts. To bound the run, set
`run_timeout_seconds`.

### A second tracking comment appeared

elek keeps one tracking comment per provider and model. Changing `provider` or
`model` on an open PR starts a new comment. Two models in two jobs also get
two comments.

### Fork pull requests

GitHub runs fork `pull_request` workflows without repository secrets and with
a read-only token. elek cannot call the model or post, so the generated
workflow skips forks. Do not use `pull_request_target` to work around this.
That event exposes your secrets to a run that PR author code can influence.
