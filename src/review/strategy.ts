import type { ActionInputs } from "../types.js";
import { normalizeReviewStrategy } from "../config.js";

export type ReviewStrategy = "solo" | "crosscheck" | "council" | "thermos";

export interface ReviewLens {
  id: string;
  title: string;
  focus: string;
}

export interface ReviewPlan {
  strategy: ReviewStrategy;
  jobs: Array<{ lens: ReviewLens }>;
}

export interface ReviewPlanSupport {
  enabled: boolean;
  warning?: string;
}

const RISK_LENS: ReviewLens = {
  id: "risk",
  title: "Thermos Security & Correctness Review",
  focus:
    "Audit changed code for concrete bugs, security vulnerabilities, breaking behavior, developer-workflow regressions, feature-gate leaks, and subtle cross-module side effects. Trace each risk end-to-end and report only verified medium-to-high impact.",
};

const DESIGN_LENS: ReviewLens = {
  id: "design",
  title: "Thermos Code Quality Review",
  focus:
    "Audit changed code for structural regressions, missed code-judo simplifications, spaghetti branching, weak abstractions, file-size growth, unclear type boundaries, and logic outside its canonical layer. Prefer fewer concepts and direct, boring code.",
};

const TESTS_LENS: ReviewLens = {
  id: "tests",
  title: "Test Integrity Review",
  focus:
    "Missing or weak tests for changed behavior, meaningless assertions, shared-state pollution, nondeterminism, untested edge cases, and gaps between the diff and the test suite.",
};

const OPERATIONS_LENS: ReviewLens = {
  id: "operations",
  title: "Operational Review",
  focus:
    "Rollout and rollback safety, migrations, configuration changes, observability, rate limits, retries, concurrency, partial updates, and production support burden.",
};

const EXTRA_LENSES: ReviewLens[] = [
  {
    id: "security-correctness",
    title: "Security & Correctness Audit",
    focus:
      "Security vulnerabilities, authorization regressions, data corruption, data loss, races, injection risks, and concrete user-visible breakage rooted in changed code.",
  },
  {
    id: "side-effects",
    title: "Breaking Side-Effects Audit",
    focus:
      "Cross-module side effects, changed contracts, backward compatibility, hidden coupling, feature regressions, and unintended breakage elsewhere in the codebase.",
  },
  {
    id: "devex-config",
    title: "DevEx & Config Audit",
    focus:
      "Developer workflow breakage, configuration drift, local build or runtime changes, dependency requirements, and generated artifact drift.",
  },
  {
    id: "feature-gates",
    title: "Feature Gate & Exposure Audit",
    focus:
      "Feature-flag leaks, internal behavior becoming public, rollout gaps, permission bypasses, and incomplete gates around partially shipped features.",
  },
  {
    id: "tests-ops",
    title: "Tests & Operations Audit",
    focus:
      "Missing tests, weak assertions, migration risk, observability gaps, timeout, retry, idempotency, and production support burden.",
  },
  {
    id: "contract-drift",
    title: "Contract Drift Audit",
    focus:
      "Consumer and provider drift in methods, paths, authentication, fields, nullability, enums, compatibility, and generated clients. Report only mismatches verified in code.",
  },
  {
    id: "mobile-runtime",
    title: "Mobile Runtime Audit",
    focus:
      "Mobile regressions in navigation, lifecycle transitions, persisted state, offline behavior, background tasks, native configuration, permissions, and platform divergence.",
  },
];

const REVIEW_LENS_CATALOG = new Map(
  [RISK_LENS, DESIGN_LENS, TESTS_LENS, OPERATIONS_LENS, ...EXTRA_LENSES]
    .map((lens) => [lens.id, lens]),
);

export function resolveReviewStrategy(raw: string | undefined): ReviewStrategy {
  return (normalizeReviewStrategy(raw) as ReviewStrategy | undefined) ?? "solo";
}

export function parseReviewLensList(raw: string | undefined): ReviewLens[] {
  const ids = [...new Set(
    (raw || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )];
  const unknown = ids.filter((id) => !REVIEW_LENS_CATALOG.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown review_lenses: ${unknown.join(", ")}. Supported values: ${[...REVIEW_LENS_CATALOG.keys()].join(", ")}`,
    );
  }
  return ids.map((id) => REVIEW_LENS_CATALOG.get(id)!);
}

export function resolveReviewPlan(inputs: ActionInputs): ReviewPlan {
  const strategy = resolveReviewStrategy(inputs.reviewStrategy);
  if (strategy === "solo") return { strategy, jobs: [] };

  const configured = parseReviewLensList(inputs.reviewLenses);
  const defaults = strategy === "council"
    ? [RISK_LENS, DESIGN_LENS, TESTS_LENS, OPERATIONS_LENS]
    : [RISK_LENS, DESIGN_LENS];
  const lenses = configured.length > 0 ? configured : defaults;
  const limit = strategy === "crosscheck" ? 2 : strategy === "council" ? 4 : 8;
  if (lenses.length > limit) {
    throw new Error(
      `review_strategy=${strategy} supports at most ${limit} review_lenses, received ${lenses.length}`,
    );
  }
  return { strategy, jobs: lenses.map((lens) => ({ lens })) };
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

export function buildSingleSessionReviewRequest(
  userRequest: string,
  plan: ReviewPlan,
): string {
  return [
    userRequest || "Review this pull request.",
    "",
    "Use one review session.",
    "Apply these review lenses before the final response:",
    ...plan.jobs.map((job, index) => `${index + 1}. ${job.lens.title}: ${job.lens.focus}`),
    "",
    "Then apply the Ponytail lens to all candidate findings:",
    "- Treat each candidate as a hypothesis and verify it against the changed code.",
    "- Reject speculative, cosmetic, duplicate, stale, and pre-existing issues.",
    "- Reject complexity concerns without a concrete correctness, maintenance, or operational risk.",
    "- Prefer the smallest root-cause fix, existing code, the standard library, and native platform features.",
    "- Do not simplify away security, validation, error handling, or tests that prevent real regressions.",
    "- Start with the supplied diff. Use read and search tools only when they resolve a specific uncertainty.",
    "",
    "Return one final review only. Follow the response shape later in this prompt.",
    "Do not return pass notes, research narration, or unfinished work.",
  ].join("\n");
}
