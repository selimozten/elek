# elek launch kit

Use these as-is or trim them for the channel.

## Short post

I just released elek v1.1.4.

elek is review-only AI code review for GitHub pull requests. It can post
structured review comments and inline threads, but in review mode it cannot
approve, merge, close, or mutate your base branch.

It is model-agnostic through pi: DeepSeek, OpenRouter, OpenAI, Anthropic,
Google, Together, xAI, and more.

Try it in one minute:

```bash
npx --package github:selimozten/elek elek-init --provider deepseek
```

Repo: https://github.com/selimozten/elek
Release: https://github.com/selimozten/elek/releases/tag/v1.1.4

## Star recovery note

If you starred elek before, GitHub may have dropped the star after an accidental
temporary visibility change. The repo is public again:

https://github.com/selimozten/elek

## Hacker News / Reddit title

Show HN: elek - review-only AI code review for GitHub pull requests

## Hacker News / Reddit body

I built elek, an open review-only AI code-review engine for GitHub pull
requests.

The main design choice is safety by construction: in review mode, the model can
read code and post review comments, including inline threads, but there is no
tool path to approve, merge, close, or mutate the base branch. The starter
workflow grants read-only contents access.

It is model-agnostic through pi, so you can use DeepSeek, OpenRouter, OpenAI,
Anthropic, Google, Together, xAI, and others. It supports solo reviews,
cross-check reviews, and council-style multi-lens reviews.

Quick start:

```bash
npx --package github:selimozten/elek elek-init --provider deepseek
```

Repo: https://github.com/selimozten/elek
Release: https://github.com/selimozten/elek/releases/tag/v1.1.4

I would especially like feedback from people who have tried AI code-review bots
and found them too noisy, too expensive, or too broadly permissioned.

## Direct message

I shipped a new release of elek, a review-only AI code-review engine for GitHub
PRs.

The safety boundary is the main thing: it can comment inline, but it cannot
approve, merge, close, or mutate the base branch in review mode.

If you have a repo where AI review noise or permissions have been a concern,
I would really value a quick look:

https://github.com/selimozten/elek

## Follow-up post

The part I care about most in elek is not "AI reviews code".

It is that the model is kept inside a review-only tool surface:

- read code
- inspect diffs
- post review comments
- post inline threads
- no approve path
- no merge path
- no close path
- no base-branch mutation in review mode

That makes AI review feel closer to CI infrastructure than an autonomous agent.

https://github.com/selimozten/elek
