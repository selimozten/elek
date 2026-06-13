# Product research

This document tracks the product bar for making elek a best-in-class
open-source review bot.

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
| Open-source BYOK agent | GitHub Actions execution, model-agnostic provider support, safe MCP surface, issue/CI automation. |

## elek positioning

elek should not compete by becoming a general coding agent. The winning lane is:

- open source and BYOK
- review-only by default
- structurally unable to approve, merge, or close
- model agnostic through pi
- transparent about model choice, review strategy, and cost
- easy to adopt with one workflow file

## Feature priorities

### Shipped

- Minimal elek brand and GitHub comment identity.
- Review-only MCP surface with inline comments and tracking updates.
- `solo`, `crosscheck`, and `council` review strategies.
- OpenRouter Kimi K2.7 Code support in examples.
- Estimated token/cost reporting through `show_cost`, `cost_rates`, and outputs.
- Cost controls through `max_cost_usd`, including conservative downgrades from
  expensive multi-lens reviews when known prompt/input estimates exceed budget.
- Strategy size guards through `max_council_changed_lines` and
  `max_crosscheck_changed_lines`, including automatic fallback for large PRs
  before model calls start.
- Zero-dependency `elek-init` setup helper that creates a starter workflow and
  repo review policy.
- Machine-readable review summary JSON with run duration, model labels,
  per-model cost, pricing source, and inline-comment posting counts.
- Repo knowledge context through bounded `knowledge_paths`, with default
  loading for common project guidance files.
- Model evaluation summary fields and `elek-eval` for scoring saved review
  summaries against seeded PR benchmark suites.
- Finding validation gates that require a concrete failure path, reject
  contradicted or unverifiable claims, and tell validators to drop weak
  candidates instead of posting caveats.

### Next

1. Benchmark fixture generator: create local seeded PR worktrees from a
   declarative suite so model comparisons can run end-to-end.
2. Review analytics: aggregate summary artifacts over time to compare noise,
   acceptance, latency, and cost by model/strategy.

## Model evaluation plan

Use a fixed benchmark suite of seeded PRs:

- correctness bug
- security regression
- missing test
- false-positive trap
- large refactor with no bug
- docs-only change

Run each model/strategy with the same prompt and score with `elek-eval`:

- valid high/medium findings
- false positives
- missed seeded bug
- cost
- duration
- inline anchoring success

Prefer model pairs that disagree usefully and keep false positives low. The
default recommendation should be cheap crosscheck plus a stronger validator only
for risky PRs.
