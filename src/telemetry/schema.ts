export type TelemetryConsentLevel = "none" | "aggregate" | "finding-metadata";
export type TelemetrySource = "action" | "cli" | "github-app";
export type FeedbackVerdict = "accepted" | "partial" | "rejected" | "unreviewed";

export interface TelemetryEnvelope {
  schema_version: "2026-06-14";
  consent_level: Exclude<TelemetryConsentLevel, "none">;
  source: TelemetrySource;
  run: {
    elek_version?: string;
    repository_visibility?: "public" | "private" | "internal" | "unknown";
    provider?: string;
    model?: string;
    review_strategy?: string;
    duration_ms?: number;
    cost_usd?: number;
    finding_count?: number;
    accepted_count?: number;
    partial_count?: number;
    rejected_count?: number;
    unreviewed_count?: number;
    inline_comments_posted?: number;
    inline_comments_skipped?: number;
    inline_comments_failed?: number;
  };
  findings?: TelemetryFindingMetadata[];
}

export interface TelemetryFindingMetadata {
  id: string;
  severity?: string;
  confidence?: string;
  file_extension?: string;
  line_bucket?: string;
  verdict?: FeedbackVerdict;
  points?: number;
  evaluator_type?: "human" | "implementation-agent" | "maintainer-agent";
}

interface ReviewSummaryLike {
  version?: number;
  run?: {
    durationSeconds?: unknown;
  };
  review?: {
    finalModel?: unknown;
    executedStrategy?: unknown;
  };
  inlineComments?: {
    posted?: unknown;
    skipped?: unknown;
    failed?: unknown;
  };
  findings?: unknown;
  cost?: {
    usd?: unknown;
  };
}

interface FindingLike {
  id?: unknown;
  severity?: unknown;
  confidence?: unknown;
  path?: unknown;
  line?: unknown;
  feedback?: {
    verdict?: unknown;
    points?: unknown;
    evaluator?: unknown;
  };
}

export const telemetrySchemaVersion = "2026-06-14" as const;

const blockedTelemetryKeys = new Set([
  "accessToken",
  "actor",
  "apiKey",
  "author",
  "baseRef",
  "body",
  "branch",
  "branchName",
  "code",
  "commit",
  "commitSha",
  "diff",
  "email",
  "evidence",
  "file",
  "filePath",
  "fix",
  "headRef",
  "impact",
  "line",
  "path",
  "password",
  "prompt",
  "rawCode",
  "rawDiff",
  "rawPrompt",
  "repository",
  "secret",
  "session",
  "sha",
  "title",
  "token",
  "url",
]);

const normalizedBlockedTelemetryKeys = new Set([...blockedTelemetryKeys].map(normalizeTelemetryKey));

export function buildTelemetryEnvelope(args: {
  consent: TelemetryConsentLevel;
  source: TelemetrySource;
  summary: ReviewSummaryLike;
  elekVersion?: string;
  repositoryVisibility?: TelemetryEnvelope["run"]["repository_visibility"];
}): TelemetryEnvelope | null {
  if (args.consent === "none") return null;

  const findings = normalizeFindings(args.summary.findings);
  const feedbackCounts = countFeedback(findings);
  const envelope: TelemetryEnvelope = {
    schema_version: telemetrySchemaVersion,
    consent_level: args.consent,
    source: args.source,
    run: {
      elek_version: args.elekVersion,
      repository_visibility: args.repositoryVisibility ?? "unknown",
      provider: providerFromModel(cleanString(args.summary.review?.finalModel)),
      model: cleanString(args.summary.review?.finalModel),
      review_strategy: cleanString(args.summary.review?.executedStrategy),
      duration_ms: secondsToMs(args.summary.run?.durationSeconds),
      cost_usd: cleanNumber(args.summary.cost?.usd),
      finding_count: findings.length,
      accepted_count: feedbackCounts.accepted,
      partial_count: feedbackCounts.partial,
      rejected_count: feedbackCounts.rejected,
      unreviewed_count: feedbackCounts.unreviewed,
      inline_comments_posted: cleanInteger(args.summary.inlineComments?.posted),
      inline_comments_skipped: cleanInteger(args.summary.inlineComments?.skipped),
      inline_comments_failed: cleanInteger(args.summary.inlineComments?.failed),
    },
  };

  if (args.consent === "finding-metadata") {
    envelope.findings = findings.map((finding) => findingMetadata(finding));
  }

  assertTelemetryIsRedacted(envelope);
  return envelope;
}

export function assertTelemetryIsRedacted(value: unknown, path = ""): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertTelemetryIsRedacted(item, `${path}${index}.`));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (normalizedBlockedTelemetryKeys.has(normalizeTelemetryKey(key))) {
      throw new Error(`Blocked telemetry field: ${path}${key}`);
    }
    assertTelemetryIsRedacted(child, `${path}${key}.`);
  }
}

function normalizeTelemetryKey(key: string): string {
  return key.replace(/[_\s-]/g, "").toLowerCase();
}

function normalizeFindings(value: unknown): FindingLike[] {
  return Array.isArray(value)
    ? value.filter((item): item is FindingLike => Boolean(item) && typeof item === "object")
    : [];
}

function findingMetadata(finding: FindingLike): TelemetryFindingMetadata {
  const feedback = finding.feedback;
  return {
    id: cleanString(finding.id) || "unknown",
    severity: cleanString(finding.severity),
    confidence: cleanString(finding.confidence),
    file_extension: fileExtension(cleanString(finding.path)),
    line_bucket: lineBucket(cleanString(finding.line)),
    verdict: feedbackVerdict(feedback?.verdict),
    points: feedbackPoints(feedback?.points),
    evaluator_type: evaluatorType(feedback?.evaluator),
  };
}

function countFeedback(findings: FindingLike[]) {
  const counts = { accepted: 0, partial: 0, rejected: 0, unreviewed: 0 };
  for (const finding of findings) {
    const verdict = feedbackVerdict(finding.feedback?.verdict) ?? "unreviewed";
    counts[verdict] += 1;
  }
  return counts;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function secondsToMs(value: unknown): number | undefined {
  const seconds = cleanNumber(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

function providerFromModel(model: string | undefined): string | undefined {
  return model?.includes("/") ? model.split("/")[0] : undefined;
}

function fileExtension(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const last = path.split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || dot === last.length - 1) return undefined;
  return last.slice(dot).toLowerCase();
}

function lineBucket(line: string | undefined): string | undefined {
  if (!line) return undefined;
  const numeric = Number.parseInt(line, 10);
  if (!Number.isFinite(numeric) || numeric < 1) return undefined;
  const start = Math.floor((numeric - 1) / 50) * 50 + 1;
  return `${start}-${start + 49}`;
}

function feedbackVerdict(value: unknown): FeedbackVerdict | undefined {
  return value === "accepted" || value === "partial" || value === "rejected" || value === "unreviewed"
    ? value
    : undefined;
}

function feedbackPoints(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5 ? value : undefined;
}

function evaluatorType(value: unknown): TelemetryFindingMetadata["evaluator_type"] | undefined {
  return value === "human" || value === "implementation-agent" || value === "maintainer-agent"
    ? value
    : undefined;
}
