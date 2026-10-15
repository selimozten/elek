/** Shared types for the elek action. */

export interface ActionInputs {
  provider: string;
  model: string;
  thinking: string;
  /** Replaces the built-in review request when set. */
  prompt: string;
  /** Optional conversation-turn cap. Undefined leaves pi unbounded by turns. */
  maxTurns?: number;
  /** Optional wall-clock timeout for one pi invocation, in seconds. */
  runTimeoutSeconds?: number;
  /** Repo-local config file path, e.g. .elek.yml. */
  configPath: string;
  stickyComment: boolean;
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
  eventAction: string;
  actor: string;
  actorAssociation?: string;
  repo: { owner: string; repo: string; fullName: string; defaultBranch: string };
  entityNumber: number;
  pr: {
    title: string;
    body: string;
    headRef: string;
    baseRef: string;
    headSha: string;
    baseSha: string;
    /** Draft PRs are not reviewed until marked ready. */
    draft?: boolean;
    /** Head branch lives in a different repository (or a deleted fork). */
    isFork?: boolean;
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
