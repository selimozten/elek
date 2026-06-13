import type { ActionInputs } from "../types";
import type { GitHubData } from "../github/data";

export type ReviewStrategy = "solo" | "crosscheck" | "council";

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
}

export interface ReviewPlan {
  strategy: ReviewStrategy;
  jobs: ReviewJob[];
  validator: ModelSpec;
}

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

export function resolveReviewStrategy(raw: string | undefined): ReviewStrategy {
  switch ((raw || "solo").trim().toLowerCase()) {
    case "crosscheck":
    case "cross-check":
    case "dual":
    case "duo":
      return "crosscheck";
    case "council":
    case "swarm":
    case "panel":
      return "council";
    case "solo":
    default:
      return "solo";
  }
}

export function parseModelSpec(raw: string, defaults: Pick<ActionInputs, "provider" | "model">): ModelSpec {
  const spec = raw.trim();
  if (!spec) {
    const label = defaults.model ? `${defaults.provider}/${defaults.model}` : defaults.provider;
    return { provider: defaults.provider, model: defaults.model, label };
  }

  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    return { provider, model: spec, label: spec };
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
  if (strategy === "solo") return { strategy, jobs: [], validator };

  const lenses =
    strategy === "crosscheck"
      ? CROSSCHECK_LENSES
      : [...CROSSCHECK_LENSES, ...COUNCIL_EXTRA_LENSES];

  const parsedModels = parseModelList(inputs.reviewModels, inputs);
  const models = parsedModels.length > 0 ? parsedModels : [parseModelSpec("", inputs)];
  const jobs = lenses.map((lens, i) => ({
    lens,
    model: models[i % models.length],
  }));

  return { strategy, jobs, validator };
}

function changedFilesBlock(data: GitHubData): string {
  if (!data.diff) return "(diff unavailable; inspect files from the workspace if needed)";
  return data.diff.length > 120_000
    ? `${data.diff.slice(0, 120_000)}\n\n... diff truncated for prompt budget; use read/grep/find/ls tools for more context.`
    : data.diff;
}

export function buildLensPrompt(params: {
  data: GitHubData;
  userRequest: string;
  lens: ReviewLens;
  modelLabel: string;
}): string {
  const { data, userRequest, lens, modelLabel } = params;
  const isPR = data.type === "pr";
  return [
    `You are an independent read-only reviewer for elek.`,
    ``,
    `Your lens: ${lens.title}`,
    `Focus: ${lens.focus}`,
    ``,
    `Hard constraints:`,
    `- Do not post GitHub comments or reviews. Your output is only an internal candidate report.`,
    `- Do not write or edit files.`,
    `- Only report issues rooted in code added or modified by this PR.`,
    `- Never present unfinished research when the repo contains the code needed to verify it.`,
    `- Prefer a few high-confidence findings over a long list of speculative notes.`,
    ``,
    `Review calibration:`,
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
    `<user_request>`,
    userRequest || "Review this pull request.",
    `</user_request>`,
    ``,
    `<changed_files>`,
    "```diff",
    changedFilesBlock(data),
    "```",
    `</changed_files>`,
    ``,
    data.comments.length
      ? `<comments>\n${data.comments.map((c) => `- ${c}`).join("\n")}\n</comments>\n`
      : "",
    data.reviewComments.length
      ? `<review_comments>\n${data.reviewComments.map((c) => `- ${c}`).join("\n")}\n</review_comments>\n`
      : "",
    `Output format:`,
    `## ${lens.title} Candidate Report`,
    ``,
    `For each finding, use this exact shape:`,
    `### [critical|important|minor] Short title`,
    `- Path: \`path/to/file\``,
    `- Line: new-diff line number if known, otherwise "body-only"`,
    `- Confidence: high|medium|low`,
    `- Evidence: quote or summarize the concrete code path`,
    `- Impact: what breaks or gets harder to maintain`,
    `- Required outcome: what must be true after a fix`,
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
}): string {
  const { data, userRequest, modelLabel, jobRunLink, commentId, reports } = params;
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
    `- Treat existing comments and review comments as already-visible context; do not duplicate findings that have already been posted unless they remain unresolved and materially changed.`,
    `- Drop speculative, cosmetic, duplicate, stale, or pre-existing issues not rooted in added/modified code.`,
    `- Drop proposed fixes that add defensive bloat for impossible states, unused abstractions, or comments that restate code.`,
    `- If two reviewers found the same issue independently, treat that as stronger signal, but still verify it yourself.`,
    `- Prefer a small number of precise, actionable comments over noisy coverage.`,
    `- Never approve, merge, close, label, or edit anything. The only GitHub-facing tools available are elek review-comment tools.`,
    ``,
    `Use the MCP proxy for visible inline findings:`,
    `- \`elek_review_create_inline_comment\` for actionable line-anchored findings.`,
    `- \`elek_review_update_tracking_comment\` only for this run's tracking comment.`,
    `Tool args are JSON strings when called through pi's \`mcp\` proxy.`,
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
    `<user_request>`,
    userRequest || "Review this pull request.",
    `</user_request>`,
    ``,
    `<changed_files>`,
    "```diff",
    changedFilesBlock(data),
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
    `- In your final text, include a concise review summary and a validation note naming which lenses ran.`,
    `- If no findings survive validation, say "No high-confidence issues survived cross-check validation."`,
    `- End with: ${modelLabel} · ${jobRunLink}`,
  ].filter(Boolean).join("\n");
}
