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
  /** Optional conversation-turn cap. Undefined leaves pi unbounded by turns. */
  maxTurns?: number;
  /** Optional wall-clock timeout for one pi invocation, in seconds. */
  runTimeoutSeconds?: number;
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
   * - crosscheck: one session with risk and design lenses
   * - council: one session with risk, design, test, and operations lenses
   * - thermos: one session with selected Thermos lenses
   */
  reviewStrategy: string;
  /** Deprecated compatibility input. */
  reviewModels: string;
  /** Optional comma-separated built-in lens IDs for one-session reviews. */
  reviewLenses?: string;
  /** Deprecated compatibility input. */
  reviewAgentCount?: number;
  /** Deprecated compatibility input. */
  advisorModel?: string;
  /** Deprecated compatibility input. */
  advisorThinking?: string;
  /** Deprecated compatibility input. */
  validatorModel: string;
  /** Deprecated compatibility input. */
  validatorThinking: string;
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
   * Deprecated compatibility input.
  */
  maxCostUsd?: number | null;
}

export interface GitHubEntityContext {
  eventName: "pull_request" | "issues" | "issue_comment" | "pull_request_review" | "pull_request_review_comment";
  eventAction: string;
  actor: string;
  actorAssociation?: string;
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

export interface PiTurnMetric {
  turn: number;
  durationSeconds: number;
  firstResponseSeconds?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  stopReason?: string;
}

export type PiRunErrorKind =
  | "empty"
  | "length"
  | "model"
  | "process"
  | "rate-limit"
  | "timeout"
  | "transport"
  | "turn-limit";

export interface PiRunResult {
  conclusion: "success" | "failure";
  output: string;
  sessionId?: string;
  turnsUsed: number;
  promptChars?: number;
  thinking?: string;
  toolCalls?: number;
  turnMetrics?: PiTurnMetric[];
  stopReason?: string;
  errorKind?: PiRunErrorKind;
  providerRetries: number;
  durationSeconds: number;
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    estimated: boolean;
    modelLabel: string;
    source: "builtin" | "override" | "provider" | "unknown";
  };
}

export interface PrepareResult {
  commentId?: number;
  branchName?: string;
  baseBranch: string;
  promptText: string;
}
