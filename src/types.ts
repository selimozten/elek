/** Shared types for pi-actions-bot */

export interface ActionInputs {
  // Trigger
  triggerPhrase: string;
  // Model
  provider: string;
  model: string;
  thinking: string;
  // Behavior
  prompt: string;
  systemPrompt: string;
  maxTurns: number;
  tools: string;
  /** Repo-local config file path, e.g. .elek.yml. */
  configPath: string;
  baseBranch?: string;
  branchPrefix: string;
  actorFilter: string;
  allowedBots: string;
  stickyComment: boolean;
  /** Mode: review (default), review+edit, or agent (legacy). */
  mode: string;
  /**
   * Review orchestration strategy:
   * - solo: one reviewer, current behavior
   * - crosscheck: two independent read-only lenses, then synthesis
   * - council: four independent read-only lenses, then synthesis
   */
  reviewStrategy: string;
  /** Optional comma-separated model specs for reviewer lenses. */
  reviewModels: string;
  /** Optional model spec for final validation/synthesis. */
  validatorModel: string;
  /** Optional prompt-level severity threshold for reported findings. */
  severityThreshold: "" | "critical" | "important" | "minor";
  /** Show estimated review cost in logs, outputs, and comments. */
  showCost: boolean;
  /**
   * Optional pricing overrides:
   * model=inputPerMillion:outputPerMillion,...
   */
  costRates: string;
  /**
   * Optional soft cap for the estimated review cost. When a multi-lens
   * strategy would exceed this cap before execution, elek downgrades to a
   * cheaper strategy.
   */
  maxCostUsd?: number;
}

export interface GitHubEntityContext {
  eventName: "pull_request" | "issues" | "issue_comment" | "pull_request_review" | "pull_request_review_comment";
  eventAction: string;
  actor: string;
  repo: { owner: string; repo: string; fullName: string; defaultBranch: string };
  entityNumber: number;
  isPR: boolean;
  /** The body/comment text that triggered the action */
  triggerText: string;
  /** PR-specific fields */
  pr?: {
    title: string;
    body: string;
    headRef: string;
    baseRef: string;
    headSha: string;
    baseSha: string;
  };
  /** Issue-specific fields */
  issue?: {
    title: string;
    body: string;
    labels: string[];
    assignees: string[];
  };
}

export interface PiRunResult {
  conclusion: "success" | "failure";
  output: string;
  sessionId?: string;
  turnsUsed: number;
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimated: boolean;
    modelLabel: string;
    source: "builtin" | "override" | "unknown";
  };
}

export interface PrepareResult {
  commentId?: number;
  branchName?: string;
  baseBranch: string;
  promptText: string;
}
