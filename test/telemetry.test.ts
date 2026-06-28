import { describe, expect, it } from "bun:test";

import { assertTelemetryIsRedacted, buildTelemetryEnvelope } from "../src/telemetry/schema";

const summary = {
  run: { durationSeconds: 12.3 },
  review: {
    finalModel: "deepseek/deepseek-v4-pro",
    executedStrategy: "crosscheck",
    branchName: "feature/private-branch",
  },
  inlineComments: { posted: 2, skipped: 1, failed: 0 },
  cost: { usd: 0.012345 },
  findings: [
    {
      id: "tenant-bypass",
      title: "Tenant bypass",
      path: "src/auth/session.ts",
      line: "121",
      evidence: "raw code should never leave",
      severity: "critical",
      confidence: "high",
      feedback: { verdict: "accepted", points: 5, evaluator: "implementation-agent" },
    },
    {
      id: "missing-test",
      path: "test/auth.test.ts",
      line: "52",
      severity: "important",
      confidence: "medium",
      feedback: { verdict: "partial", points: 3, evaluator: "maintainer-agent" },
    },
  ],
};

describe("telemetry schema", () => {
  it("returns null when telemetry consent is none", () => {
    expect(buildTelemetryEnvelope({ consent: "none", source: "action", summary })).toBeNull();
  });

  it("builds aggregate telemetry without per-finding metadata or blocked fields", () => {
    const envelope = buildTelemetryEnvelope({
      consent: "aggregate",
      source: "action",
      summary,
      elekVersion: "1.2.3",
      repositoryVisibility: "private",
    });

    expect(envelope).toEqual({
      schema_version: "2026-06-14",
      consent_level: "aggregate",
      source: "action",
      run: {
        elek_version: "1.2.3",
        repository_visibility: "private",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-pro",
        review_strategy: "crosscheck",
        duration_ms: 12300,
        cost_usd: 0.012345,
        finding_count: 2,
        accepted_count: 1,
        partial_count: 1,
        rejected_count: 0,
        unreviewed_count: 0,
        inline_comments_posted: 2,
        inline_comments_skipped: 1,
        inline_comments_failed: 0,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("feature/private-branch");
    expect(JSON.stringify(envelope)).not.toContain("src/auth/session.ts");
    expect(JSON.stringify(envelope)).not.toContain("raw code should never leave");
  });

  it("builds finding metadata with extensions and coarse line buckets only", () => {
    const envelope = buildTelemetryEnvelope({ consent: "finding-metadata", source: "cli", summary });

    expect(envelope?.findings).toEqual([
      {
        id: "tenant-bypass",
        severity: "critical",
        confidence: "high",
        file_extension: ".ts",
        line_bucket: "101-150",
        verdict: "accepted",
        points: 5,
        evaluator_type: "implementation-agent",
      },
      {
        id: "missing-test",
        severity: "important",
        confidence: "medium",
        file_extension: ".ts",
        line_bucket: "51-100",
        verdict: "partial",
        points: 3,
        evaluator_type: "maintainer-agent",
      },
    ]);
    expect(JSON.stringify(envelope)).not.toContain("src/auth/session.ts");
    expect(JSON.stringify(envelope)).not.toContain("test/auth.test.ts");
  });

  it("rejects telemetry objects containing blocked raw fields", () => {
    expect(() => assertTelemetryIsRedacted({ run: { branch: "main" } })).toThrow("Blocked telemetry field");
    expect(() => assertTelemetryIsRedacted({ findings: [{ rawDiff: "@@ secret" }] })).toThrow("Blocked telemetry field");
    expect(() => assertTelemetryIsRedacted({ findings: [{ raw_diff: "@@ secret" }] })).toThrow("Blocked telemetry field");
    expect(() => assertTelemetryIsRedacted({ findings: [{ "raw diff": "@@ secret" }] })).toThrow("Blocked telemetry field");
    expect(() => assertTelemetryIsRedacted({ findings: [{ file_path: "src/secret.ts" }] })).toThrow("Blocked telemetry field");
    expect(() => assertTelemetryIsRedacted({ run: { commit_sha: "abc123" } })).toThrow("Blocked telemetry field");
    expect(() => assertTelemetryIsRedacted({ run: { apiKey: "sk-secret" } })).toThrow("Blocked telemetry field");
    expect(() => assertTelemetryIsRedacted({ run: { "api key": "sk-secret" } })).toThrow("Blocked telemetry field");
    expect(() => assertTelemetryIsRedacted({ run: { access_token: "secret" } })).toThrow("Blocked telemetry field");
  });

  it("rejects secret / PII values smuggled into allowed fields", () => {
    const smuggled = [
      "ghp_exampletoken0123456789abcdefABCDEF",
      "sk-abcdef0123456789ABCDEF",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "jane.doe@example.com",
    ];
    for (const value of smuggled) {
      expect(() => assertTelemetryIsRedacted({ findings: [{ id: value }] })).toThrow("Blocked telemetry value");
    }
  });
});
