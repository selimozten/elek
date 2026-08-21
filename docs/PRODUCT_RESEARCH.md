# Product research

This document tracks the product bar for making elek a best-in-class,
GitHub App-first review product with an auditable open core.

## Market pattern

The strongest review tools are converging on the same capabilities:

| Archetype | Strong signals |
|---|---|
| Managed PR reviewer | YAML configuration, path-based instructions, knowledge base, PR summaries, IDE/CLI review, issue/planning workflows. |
| Native platform reviewer | Native repository entry points, suggested changes, handoff from review to coding agent. |
| Multi-agent reviewer | Specialized review agents, rule enforcement, context-aware feedback, configuration-driven behavior. |
| Repo-indexed reviewer | Full-codebase context, code graph/indexing, team style learning, analytics, self-hosting focus. |
| Enterprise reviewer | Repository-aware reviews using AST/symbol/embedding context, docs/wiki context, privacy positioning. |
| Low-friction reviewer | Automatic review on every PR, summary plus line-by-line comments, multiple Git surfaces. |
| Open-source BYOK agent | GitHub Actions execution, model-agnostic provider support, read-only review tools, issue/CI automation. |

## elek positioning

elek should not compete by becoming a general coding agent. The winning lane is:

- hosted GitHub App as the primary install and brand surface
- open review engine, CLI tools, schemas, and self-hosted runtime
- BYOK and self-hosting for teams that need control
- review-only by default
- structurally unable to approve, merge, or close
- model agnostic through pi
- transparent about model choice, review strategy, cost, and accepted finding rate
- useful feedback analytics so teams can choose models by signal-to-noise

## Feature priorities

### Shipped

- Minimal elek brand and GitHub comment identity.
- One-session review path with native Pi read-only tools and host delivery.
- `solo`, `crosscheck`, and `council` review strategies.
- OpenRouter Kimi K2.7 Code support in examples.
- Estimated token/cost reporting through `show_cost`, `cost_rates`, and outputs.
- Cost reporting without review-coverage downgrades.
- Model-aware diff context budgets that preserve the requested review strategy
  and use the available GLM, GPT, or Kimi context window before falling back to
  per-file slices.
- Zero-dependency `elek-init` setup helper that creates a starter workflow and
  repo review policy.
- Machine-readable review summary JSON with run duration, model labels,
  per-model cost, pricing source, stable finding IDs, and inline-comment
  posting counts.
- Repo knowledge context through bounded `knowledge_paths`, with default
  loading for common project guidance files.
- Model evaluation summary fields and `elek-eval` for scoring saved review
  summaries against seeded PR benchmark suites.
- `elek-benchmark` for bootstrapping editable benchmark suite cases from saved
  review summary artifacts.
- `elek-analytics` for aggregating saved summary artifacts by strategy, model,
  or repository to compare cost, latency, findings, and inline comment health,
  finding acceptance/score feedback, plus baseline/current trend comparison for
  regression checks.
- `elek-feedback` for agent-native per-finding adjudication so the
  implementation agent or maintainer can mark findings accepted, partial,
  rejected, or unreviewed with a `0-5` usefulness score.
- Finding guidance that requires a concrete failure path and rejects
  contradicted or unverifiable claims.

### Next

1. GitHub App install path: make branded hosted reviews the primary onboarding
   path while keeping the Action as the advanced self-hosted runtime.
2. Public telemetry contract: add opt-in aggregate and finding-metadata schemas
   plus redaction tests that prove raw code, diffs, prompts, file paths,
   branch names, commit SHAs, secrets, and author identities are excluded.
3. Benchmark fixture runner: create local seeded PR worktrees from a
   declarative suite so model comparisons can run end-to-end.
4. Community model leaderboard: publish anonymized aggregate feedback reports
   so projects can compare model quality, cost, latency, and false positives.

## Model evaluation plan

Use a fixed benchmark suite of seeded PRs:

- correctness bug
- security regression
- missing test
- false-positive trap
- large refactor with no bug
- docs-only change

Run each model and lens set with the same prompt. Score with `elek-eval`:

- valid high/medium findings
- false positives
- missed seeded bug
- cost
- duration
- inline anchoring success

Prefer one capable model with low false positives. Add another workflow only
when benchmark evidence shows a quality gain.
