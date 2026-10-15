---
name: Feature request
about: Suggest an addition or improvement
title: "[feat] "
labels: enhancement
---

## What you want

<!-- One paragraph: what should elek do that it doesn't? -->

## Why

<!-- The problem this solves. A real workflow you'd run if this existed. -->

## Sketch

<!-- If you've thought about it: what would the input/output look like?
     E.g., a snippet of YAML the user would write. -->

## Alternatives considered

<!-- Have you tried a workaround? Why isn't it good enough? -->

## Out of scope (please confirm)

This proposal does NOT:

- [ ] Add a code path that calls `pulls.merge`, `pulls.createReview({event:"APPROVE"})`, or `issues.update({state:"closed"})`
- [ ] Give the model shell, write, MCP, or GitHub access
- [ ] Import a model-specific SDK

If any of those are checked, expect significant pushback — see [AGENTS.md](../../AGENTS.md).
