import type { GitHubEntityContext, PiRunResult } from "../types.js";
import type { ReviewCost, ReviewCostTotal } from "./cost.js";
import type { PostSummary } from "../entrypoints/post-buffered.js";
import { uniqueFindingId, type ParsedReviewFinding } from "./findings.js";

export interface ReviewRunMetric {
  role: "reviewer" | "validator";
  lensId?: string;
  lensTitle?: string;
  modelLabel: string;
  conclusion: "success" | "failure";
  turnsUsed: number;
  durationSeconds: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEstimated: boolean;
  pricingSource: "builtin" | "override" | "unknown";
}

export interface ReviewSummaryInput {
  context: GitHubEntityContext;
  runId: string;
  jobRunLink: string;
  conclusion: "success" | "failure";
  mode: string;
  requestedStrategy: string;
  executedStrategy: string;
  primaryModelLabel: string;
  finalModelLabel: string;
  startedAt: Date;
  finishedAt: Date;
  commentId?: number;
  branchName?: string;
  inlineComments: PostSummary;
  costTotal: ReviewCostTotal;
  runs: ReviewRunMetric[];
  findings?: ParsedReviewFinding[];
}

export function metricFromPiRun(
  result: PiRunResult,
  role: ReviewRunMetric["role"],
  metadata: { lensId?: string; lensTitle?: string } = {},
): ReviewRunMetric {
  return {
    role,
    ...metadata,
    modelLabel: result.usage.modelLabel,
    conclusion: result.conclusion,
    turnsUsed: result.turnsUsed,
    durationSeconds: roundSeconds(result.durationSeconds),
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: roundUsd(result.costUsd),
    costEstimated: result.usage.estimated,
    pricingSource: result.usage.source,
  };
}

export function buildReviewSummary(input: ReviewSummaryInput) {
  const entityType = input.context.isPR ? "pull_request" : "issue";
  const usedFindingIds = new Map<string, number>();
  return {
    version: 1,
    generatedAt: input.finishedAt.toISOString(),
    repository: input.context.repo.fullName,
    run: {
      id: input.runId,
      url: input.jobRunLink,
      durationSeconds: roundSeconds(
        (input.finishedAt.getTime() - input.startedAt.getTime()) / 1000,
      ),
      conclusion: input.conclusion,
    },
    entity: {
      type: entityType,
      number: input.context.entityNumber,
      title: input.context.pr?.title || input.context.issue?.title || "",
      actor: input.context.actor,
      event: input.context.eventName,
      action: input.context.eventAction,
    },
    review: {
      mode: input.mode,
      requestedStrategy: input.requestedStrategy || "solo",
      executedStrategy: input.executedStrategy,
      primaryModel: input.primaryModelLabel,
      finalModel: input.finalModelLabel,
      branchName: input.branchName || "",
      commentId: input.commentId ? String(input.commentId) : "",
    },
    inlineComments: {
      posted: input.inlineComments.posted,
      skipped: input.inlineComments.skipped,
      failed: input.inlineComments.failed,
    },
    findings: (input.findings ?? []).map((finding, index) => ({
      ...finding,
      id: finding.id || uniqueFindingId(finding.title, index, usedFindingIds),
    })),
    cost: {
      usd: roundUsd(input.costTotal.costUsd),
      inputTokens: input.costTotal.inputTokens,
      outputTokens: input.costTotal.outputTokens,
      estimated: input.costTotal.estimated,
      runs: input.costTotal.runs.map((run) => costRunSummary(run)),
    },
    modelRuns: input.runs,
  };
}

function costRunSummary(run: ReviewCost) {
  return {
    modelLabel: run.modelLabel,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: roundUsd(run.costUsd),
    estimated: run.estimated,
    pricingSource: run.source,
  };
}

function roundSeconds(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function roundUsd(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}
