import type { ActionInputs } from "../types.js";
import type { GitHubData } from "../github/data.js";
import { mcpToolGuidance } from "../github/mcp-guidance.js";
import { findingValidationBullets, reviewContractBullets, reviewFindingTemplate } from "./contract.js";
import { formatConfigPromptBlock, normalizeReviewStrategy, type ElekConfig } from "../config.js";
import { aggregateCosts, formatUsd, type ReviewCost } from "./cost.js";

export type ReviewStrategy = "solo" | "crosscheck" | "council" | "thermos";

export interface ModelSpec {
  provider: string;
  model: string;
  label: string;
}

export interface ReviewLens {
  id: string;
  title: string;
  focus: string;
}

export interface ReviewJob {
  lens: ReviewLens;
  model: ModelSpec;
  role?: "reviewer" | "validator-review";
}

export interface ReviewPlan {
  strategy: ReviewStrategy;
  jobs: ReviewJob[];
  validatorReview?: ReviewJob;
  validator: ModelSpec;
  reusedModels: boolean;
}

export interface ReviewPlanSupport {
  enabled: boolean;
  warning?: string;
}

export interface BudgetPlanEvent {
  level: "log" | "warn";
  message: string;
}

export interface BudgetPlanResult {
  plan: ReviewPlan;
  support: ReviewPlanSupport;
  events: BudgetPlanEvent[];
}

const DEFAULT_MAX_COUNCIL_CHANGED_LINES = 1_200;
const DEFAULT_MAX_CROSSCHECK_CHANGED_LINES = 3_000;

const CROSSCHECK_LENSES: ReviewLens[] = [
  {
    id: "risk",
    title: "Risk Review",
    focus:
      "Correctness, security, breaking changes, developer-experience regressions, feature-gate leaks, data loss, authz/authn gaps, injection risks, and user-visible regressions.",
  },
  {
    id: "design",
    title: "Design Review",
    focus:
      "Maintainability, structural simplification, abstraction quality, file-size growth, ad-hoc branching, type boundaries, canonical layer ownership, and codebase health.",
  },
];

const COUNCIL_EXTRA_LENSES: ReviewLens[] = [
  {
    id: "tests",
    title: "Test Integrity Review",
    focus:
      "Missing or weak tests for changed behavior, meaningless assertions, shared-state pollution, nondeterminism, untested edge cases, and gaps between the diff and the test suite.",
  },
  {
    id: "operations",
    title: "Operational Review",
    focus:
      "Rollout and rollback safety, migrations, configuration/env changes, observability, rate limits, retries, concurrency, partial updates, and production support burden.",
  },
];

const THERMOS_LENSES: ReviewLens[] = [
  {
    id: "security-correctness",
    title: "Security & Correctness Audit",
    focus:
      "Security vulnerabilities, auth/authz regressions, data corruption, data loss, race conditions, injection risks, and concrete user-visible breakage rooted in changed code.",
  },
  {
    id: "side-effects",
    title: "Breaking Side-Effects Audit",
    focus:
      "Cross-module and cross-package side effects, changed contracts, backward compatibility, hidden coupling, feature behavior regressions, and unintended breakage elsewhere in the codebase.",
  },
  {
    id: "devex-config",
    title: "DevEx & Config Audit",
    focus:
      "Developer workflow breakage, env var/config drift, local build/test/runtime changes, dependency or script requirements that alter normal development, and generated artifact drift.",
  },
  {
    id: "feature-gates",
    title: "Feature Gate & Exposure Audit",
    focus:
      "Feature-flag leaks, internal-only behavior becoming public, rollout/kill-switch gaps, permission bypasses, and incomplete gating around partially shipped features.",
  },
  {
    id: "tests-ops",
    title: "Tests & Operations Audit",
    focus:
      "Missing tests for changed behavior, weak assertions, migration/rollback risk, observability gaps, timeout/retry/idempotency issues, and production support burden.",
  },
];

const VALIDATOR_REVIEW_LENS: ReviewLens = {
  id: "validator-self-review",
  title: "Final Model Independent Audit",
  focus:
    "Run your own fresh security and correctness audit before synthesis. Do not rely on candidate reports; independently trace changed-code failure paths and report only medium-to-high risk issues.",
};

const MAX_THERMOS_REVIEW_AGENTS = 8;

export function resolveReviewStrategy(raw: string | undefined): ReviewStrategy {
  return (normalizeReviewStrategy(raw) as ReviewStrategy | undefined) ?? "solo";
}

export function parseModelSpec(raw: string, defaults: Pick<ActionInputs, "provider" | "model">): ModelSpec {
  const spec = raw.trim().replace(/^\/+/, "");
  if (!spec) {
    const label = defaults.model ? `${defaults.provider}/${defaults.model}` : defaults.provider;
    return { provider: defaults.provider, model: defaults.model, label };
  }

  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const modelPart = spec.slice(slash + 1).replace(/^\/+|\/+$/g, "").trim();
    if (!modelPart) {
      return { provider, model: "", label: provider };
    }
    const model = `${provider}/${modelPart}`;
    return { provider, model, label: model };
  }

  return {
    provider: defaults.provider,
    model: spec,
    label: `${defaults.provider}/${spec}`,
  };
}

export function parseModelList(raw: string, defaults: Pick<ActionInputs, "provider" | "model">): ModelSpec[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseModelSpec(s, defaults));
}

export function resolveReviewPlan(inputs: ActionInputs): ReviewPlan {
  const strategy = resolveReviewStrategy(inputs.reviewStrategy);
  const validator = parseModelSpec(inputs.validatorModel, inputs);
  if (strategy === "solo") return { strategy, jobs: [], validator, reusedModels: false };

  const parsedModels = parseModelList(inputs.reviewModels, inputs);
  const lenses =
    strategy === "crosscheck"
      ? CROSSCHECK_LENSES
      : strategy === "council"
        ? [...CROSSCHECK_LENSES, ...COUNCIL_EXTRA_LENSES]
        : thermosLenses(inputs.reviewAgentCount, parsedModels.length);
  const models = parsedModels.length > 0 ? parsedModels : [parseModelSpec("", inputs)];
  const reusedModels = lenses.length > models.length;
  const jobs = lenses.map((lens, i) => ({
    lens,
    model: models[i % models.length],
    role: "reviewer" as const,
  }));
  const validatorReview = {
    lens: VALIDATOR_REVIEW_LENS,
    model: validator,
    role: "validator-review" as const,
  };

  return { strategy, jobs, validatorReview, validator, reusedModels };
}

export function downgradeReviewStrategy(strategy: ReviewStrategy): ReviewStrategy | undefined {
  if (strategy === "thermos") return "council";
  if (strategy === "council") return "crosscheck";
  if (strategy === "crosscheck") return "solo";
  return undefined;
}

function thermosLenses(requestedCount: number | undefined, modelCount: number): ReviewLens[] {
  const count = Math.min(
    MAX_THERMOS_REVIEW_AGENTS,
    Math.max(1, requestedCount ?? Math.max(THERMOS_LENSES.length, modelCount)),
  );
  if (count <= THERMOS_LENSES.length) return THERMOS_LENSES.slice(0, count);
  const lenses = [...THERMOS_LENSES];
  for (let i = THERMOS_LENSES.length + 1; i <= count; i++) {
    lenses.push({
      id: `independent-audit-${i}`,
      title: `Independent Audit ${i}`,
      focus:
        "Fresh Thermos-style audit from another angle: changed-code bugs, security, breaking behavior, feature leaks, developer workflow breakage, and missing high-signal tests.",
    });
  }
  return lenses;
}

export function resolveReviewPlanSupport(
  strategy: ReviewStrategy,
  context: { isPR: boolean; mode: string },
): ReviewPlanSupport {
  if (strategy === "solo") return { enabled: false };
  if (!context.isPR) {
    return {
      enabled: false,
      warning: `Review strategy ${strategy} requires a pull request; running solo review instead.`,
    };
  }
  if (context.mode !== "review") {
    return {
      enabled: false,
      warning: `Review strategy ${strategy} is only supported in mode=review; running solo review because mode=${context.mode}.`,
    };
  }
  return { enabled: true };
}

export function selectReviewPlanWithinBudget(args: {
  inputs: ActionInputs;
  initialPlan: ReviewPlan;
  supportContext: { isPR: boolean; mode: string };
  estimateCosts: (plan: ReviewPlan) => ReviewCost[];
}): BudgetPlanResult {
  let plan = args.initialPlan;
  let support = resolveReviewPlanSupport(plan.strategy, args.supportContext);
  const events: BudgetPlanEvent[] = [];
  const maxCostUsd = args.inputs.maxCostUsd;

  if (!support.enabled || maxCostUsd === undefined) {
    return { plan, support, events };
  }

  const costLabel = (costUsd: number) => `${formatUsd(costUsd)} (${costUsd.toFixed(6)})`;

  for (;;) {
    const plannedCost = aggregateCosts(args.estimateCosts(plan));
    const hasUnknownPricing = plannedCost.runs.some((run) => run.source === "unknown");
    const knownCostUsd = plannedCost.runs
      .filter((run) => run.source !== "unknown")
      .reduce((sum, run) => sum + run.costUsd, 0);
    const comparableCostUsd = hasUnknownPricing ? knownCostUsd : plannedCost.costUsd;

    if (hasUnknownPricing) {
      events.push({
        level: "warn",
        message:
          `[cost] max_cost_usd=${costLabel(maxCostUsd)} has incomplete pricing for ${plan.strategy}; ` +
          `provide cost_rates for all planned models.`,
      });
    }
    events.push({
      level: "log",
      message:
        `[cost] planned_minimum_input_cost=${costLabel(comparableCostUsd)} ` +
        `strategy=${plan.strategy} max_cost_usd=${costLabel(maxCostUsd)}`,
    });
    if (comparableCostUsd <= maxCostUsd) break;

    const downgraded = downgradeReviewStrategy(plan.strategy);
    if (!downgraded) break;
    events.push({
      level: "warn",
      message:
        `[cost] ${plan.strategy} exceeds max_cost_usd=${costLabel(maxCostUsd)} ` +
        `before output tokens; downgrading to ${downgraded}.`,
    });
    plan = resolveReviewPlan({ ...args.inputs, reviewStrategy: downgraded });
    support = resolveReviewPlanSupport(plan.strategy, args.supportContext);
    if (!support.enabled) break;
  }

  return { plan, support, events };
}

export function countChangedDiffLines(diff: string | undefined): number | undefined {
  if (!diff) return undefined;
  let changed = 0;
  for (const line of diff.split("\n")) {
    if (!line) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    // Unified diffs represent a modified line as one deletion plus one addition.
    if (line.startsWith("+") || line.startsWith("-")) changed++;
  }
  return changed;
}

function changedLineLimitForStrategy(strategy: ReviewStrategy, inputs: ActionInputs): number | undefined {
  if (strategy === "council" || strategy === "thermos") {
    const limit = inputs.maxCouncilChangedLines ?? DEFAULT_MAX_COUNCIL_CHANGED_LINES;
    return limit === 0 ? undefined : limit;
  }
  if (strategy === "crosscheck") {
    const limit = inputs.maxCrosscheckChangedLines ?? DEFAULT_MAX_CROSSCHECK_CHANGED_LINES;
    return limit === 0 ? undefined : limit;
  }
  return undefined;
}

function changedLineLimitNameForStrategy(strategy: ReviewStrategy): string {
  if (strategy === "thermos" || strategy === "council") return "max_council_changed_lines";
  if (strategy === "crosscheck") return "max_crosscheck_changed_lines";
  return "max_changed_lines";
}

export function selectReviewPlanWithinDiffSize(args: {
  inputs: ActionInputs;
  initialPlan: ReviewPlan;
  supportContext: { isPR: boolean; mode: string };
  changedLines: number | undefined;
}): BudgetPlanResult {
  let plan = args.initialPlan;
  let support = resolveReviewPlanSupport(plan.strategy, args.supportContext);
  const events: BudgetPlanEvent[] = [];

  if (!support.enabled || args.changedLines === undefined) {
    return { plan, support, events };
  }

  for (;;) {
    const limit = changedLineLimitForStrategy(plan.strategy, args.inputs);
    if (limit === undefined || args.changedLines <= limit) break;

    const downgraded = downgradeReviewStrategy(plan.strategy);
    if (!downgraded) break;
    events.push({
      level: "warn",
      message:
        `[size] changed_lines=${args.changedLines} strategy=${plan.strategy} ` +
        `${changedLineLimitNameForStrategy(plan.strategy)}=${limit}; downgrading to ${downgraded}.`,
    });
    plan = resolveReviewPlan({ ...args.inputs, reviewStrategy: downgraded });
    support = resolveReviewPlanSupport(plan.strategy, args.supportContext);
    if (!support.enabled) break;
  }

  return { plan, support, events };
}

function changedFilesBlock(data: GitHubData, maxChars = 60_000): string {
  if (!data.diff) return "(diff unavailable; inspect files from the workspace if needed)";
  return data.diff.length > maxChars
    ? `${data.diff.slice(0, maxChars)}\n\n... diff truncated for prompt budget; use read/grep/find/ls tools for more context.`
    : data.diff;
}

export function buildLensPrompt(params: {
  data: GitHubData;
  userRequest: string;
  lens: ReviewLens;
  modelLabel: string;
  repoConfig?: ElekConfig;
  includeDiscussion?: boolean;
}): string {
  const { data, userRequest, lens, modelLabel, repoConfig, includeDiscussion = true } = params;
  const isPR = data.type === "pr";
  const entityLabel = isPR ? "pull request" : "issue";
  const configBlock = repoConfig ? formatConfigPromptBlock(repoConfig) : [];
  return [
    `You are an independent read-only reviewer for elek.`,
    ``,
    `Your lens: ${lens.title}`,
    `Focus: ${lens.focus}`,
    ``,
    `Available tools: \`read\`, \`grep\`, \`find\`, \`ls\` — use them to inspect surrounding code before reporting.`,
    ``,
    `Hard constraints:`,
    `- Do not post GitHub comments or reviews. Your output is only an internal candidate report.`,
    `- Do not write or edit files.`,
    `- Only report issues rooted in code added or modified by this PR.`,
    `- Do not paste raw diff blocks into your candidate report; quote only minimal evidence.`,
    `- Do not claim external packages, GitHub Actions, model IDs, or APIs do not exist unless you can verify it from current repo files, package-manager output, or workflow error logs.`,
    `- Never present unfinished research when the repo contains the code needed to verify it.`,
    `- Prefer a few high-confidence findings over a long list of speculative notes.`,
    ``,
    `Thermos-style audit calibration:`,
    `- Be extremely thorough tracing side effects, but report only medium-to-high risk issues with verified impact.`,
    `- Catch breaking functionality, breaking developer workflow, security vulnerabilities, and feature-gate leaks rooted in this diff.`,
    `- If the branch intentionally changes behavior and the blast radius is clear and constrained, do not report intended breakage as a bug.`,
    `- Never overstate severity; false positives are review failures.`,
    `- Do your audit with fresh eyes. Do not depend on existing PR discussion; the final validator will compare discussion after candidate reports are produced.`,
    ``,
    `Review calibration:`,
    ...reviewContractBullets(),
    ``,
    `Finding acceptance gates:`,
    ...findingValidationBullets(),
    ``,
    `- For risk findings, trace the failure end-to-end and explain concrete impact.`,
    `- For design findings, push for structural simplification only when the cleaner shape is visible.`,
    `- Reject cosmetic nits unless they reveal a larger maintainability issue.`,
    `- If no high-confidence findings exist, say so plainly.`,
    ``,
    `<context>`,
    `${isPR ? "PR" : "Issue"} Title: ${data.title}`,
    `Author: ${data.author}`,
    `Entity: #${data.entityNumber}`,
    isPR && data.pr ? `Branch: ${data.pr.headRef} -> ${data.pr.baseRef}` : "",
    `Reviewer model: ${modelLabel}`,
    `</context>`,
    ``,
    `<body>`,
    data.body || "(no description)",
    `</body>`,
    ``,
    configBlock.length ? `<elek_config>\n${configBlock.join("\n")}\n</elek_config>\n` : "",
    `<user_request>`,
    userRequest || `Review this ${entityLabel}.`,
    `</user_request>`,
    ``,
    `<changed_files>`,
    "```diff",
    changedFilesBlock(data),
    "```",
    `</changed_files>`,
    ``,
    includeDiscussion && data.comments.length
      ? `<comments>\n${data.comments.map((c) => `- ${c}`).join("\n")}\n</comments>\n`
      : "",
    includeDiscussion && data.reviewComments.length
      ? `<review_comments>\n${data.reviewComments.map((c) => `- ${c}`).join("\n")}\n</review_comments>\n`
      : "",
    `Output format:`,
    `## ${lens.title} Candidate Report`,
    ``,
    `For each finding, use this exact shape:`,
    ...reviewFindingTemplate(),
    ``,
    `If you have no high-confidence findings, output:`,
    `## ${lens.title} Candidate Report`,
    `No high-confidence findings.`,
  ].filter(Boolean).join("\n");
}

export function buildSynthesisPrompt(params: {
  data: GitHubData;
  userRequest: string;
  modelLabel: string;
  jobRunLink: string;
  commentId?: number;
  reports: Array<{ lens: ReviewLens; modelLabel: string; output: string; conclusion: "success" | "failure" }>;
  repoConfig?: ElekConfig;
}): string {
  const { data, userRequest, modelLabel, jobRunLink, commentId, reports, repoConfig } = params;
  const configBlock = repoConfig ? formatConfigPromptBlock(repoConfig) : [];
  const reportBlock = reports
    .map((r) =>
      [
        `<reviewer_report lens="${r.lens.id}" title="${r.lens.title}" model="${r.modelLabel}" conclusion="${r.conclusion}">`,
        r.output || "(no output)",
        `</reviewer_report>`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `You are elek's final review validator and synthesizer.`,
    ``,
    `You have independent candidate reports from read-only reviewers. Treat every candidate finding as a hypothesis, not a fact.`,
    ``,
    `Validation rules:`,
    `- Verify each surviving finding against the diff and repo context before surfacing it.`,
    ...reviewContractBullets(),
    ``,
    `Finding acceptance gates:`,
    ...findingValidationBullets(),
    ``,
    `- Do not surface claims that external packages, GitHub Actions, model IDs, or APIs do not exist unless they are backed by current repo files, package-manager output, or workflow error logs.`,
    `- Treat existing comments and review comments as already-visible context; do not duplicate findings that have already been posted unless they remain unresolved and materially changed.`,
    `- Drop speculative, cosmetic, duplicate, stale, or pre-existing issues not rooted in added/modified code.`,
    `- If two reviewers found the same issue independently, treat that as stronger signal, but still verify it yourself.`,
    `- Prefer a small number of precise, actionable comments over noisy coverage.`,
    `- Never approve, merge, close, label, or edit anything. The only GitHub-facing tools available are elek review-comment tools.`,
    ``,
    `Use the MCP proxy for visible inline findings:`,
    ``,
    `### Available tools (via the \`mcp\` proxy)`,
    ``,
    ...mcpToolGuidance(),
    ``,
    `<context>`,
    `${data.type === "pr" ? "PR" : "Issue"} Title: ${data.title}`,
    `Author: ${data.author}`,
    `Entity: #${data.entityNumber}`,
    data.type === "pr" && data.pr ? `Branch: ${data.pr.headRef} -> ${data.pr.baseRef}` : "",
    `Final model: ${modelLabel}`,
    commentId ? `comment_id: ${commentId}` : "",
    `</context>`,
    ``,
    `<body>`,
    data.body || "(no description)",
    `</body>`,
    ``,
    configBlock.length ? `<elek_config>\n${configBlock.join("\n")}\n</elek_config>\n` : "",
    `<user_request>`,
    userRequest || "Review this pull request.",
    `</user_request>`,
    ``,
    `<changed_files>`,
    "```diff",
    changedFilesBlock(data, 60_000),
    "```",
    `</changed_files>`,
    ``,
    data.comments.length
      ? `<comments>\n${data.comments.map((c) => `- ${c}`).join("\n")}\n</comments>\n`
      : "",
    data.reviewComments.length
      ? `<review_comments>\n${data.reviewComments.map((c) => `- ${c}`).join("\n")}\n</review_comments>\n`
      : "",
    `<candidate_reports>`,
    reportBlock,
    `</candidate_reports>`,
    ``,
    `Final output requirements:`,
    `- Post inline MCP comments for validated line-anchored findings.`,
    `- For every top-level finding, use this exact shape:`,
    ...reviewFindingTemplate(),
    `- In your final text, include a concise review summary and a validation note naming which lenses ran.`,
    `- If no findings survive validation, say "No high-confidence issues survived cross-check validation."`,
    `- End with: ${modelLabel} · ${jobRunLink}`,
  ].filter(Boolean).join("\n");
}
