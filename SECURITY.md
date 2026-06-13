# Security Policy

elek is designed as a review-only GitHub Action. The model-facing MCP server
exposes only `create_inline_comment` and `update_tracking_comment`; it has no
code path for approving, merging, closing, or changing repository settings.

## Supported Versions

Security fixes target the latest `v1.x` release and the moving `v1` action
tag. Pin `selimozten/elek@v1` for normal use, or pin an exact patch tag when
you need reproducible workflow behavior.

## Reporting a Vulnerability

Do not open a public issue for vulnerabilities that expose credentials,
repository write access, private code, or a bypass of the review-only tool
surface.

Preferred reporting path:

1. Use GitHub private vulnerability reporting for this repository if it is
   available.
2. If private reporting is unavailable, open a minimal public issue asking for
   a private contact path. Do not include exploit details, tokens, logs, or
   private repository names in that issue.

Useful reports include:

- The action version or commit SHA.
- A minimal workflow snippet with secrets redacted.
- The GitHub event type and permissions block.
- Whether the run was on a fork PR.
- The provider/model used, with API keys redacted.
- A clear impact statement: token exposure, unauthorized write path, comment
  spoofing, dependency execution issue, or denial of service.

## Scope

In scope:

- Token leakage in prompts, logs, comments, MCP buffers, or temporary files.
- A path that lets the model approve, merge, close, or mutate repository
  settings through elek.
- Unsafe default permissions or tool surfaces.
- Dependency or runtime behavior that executes untrusted code unexpectedly.
- Comment spoofing or identity confusion that could mislead maintainers.

Out of scope:

- Model hallucinations that do not gain privileges or leak sensitive data.
- Expected GitHub token limitations, such as `GITHUB_TOKEN` reviews not
  satisfying required reviewer counts.
- Findings that require the workflow owner to deliberately grant broad
  permissions and use `mode: agent`.
