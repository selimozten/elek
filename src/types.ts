/** Shared types for the elek action. */

export interface ActionInputs {
  provider: string;
  model: string;
  thinking: string;
  /** Replaces the built-in review request when set. */
  prompt: string;
  /** Optional wall-clock timeout for one pi invocation, in seconds. */
  runTimeoutSeconds?: number;
  /** Repo-local config file path, e.g. .elek.yml. */
  configPath: string;
  stickyComment: boolean;
  /** Optional prompt-level severity threshold for reported findings. */
  severityThreshold: "" | "critical" | "important" | "minor";
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

export type PiRunErrorKind =
  | "empty"
  | "length"
  | "model"
  | "process"
  | "rate-limit"
  | "timeout"
  | "transport";

export interface PiRunResult {
  conclusion: "success" | "failure";
  output: string;
  errorKind?: PiRunErrorKind;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** No provider usage was reported; counts come from prompt/output length. */
    estimated: boolean;
  };
}
