# Telemetry

Telemetry is off by default. Public `elek` code only defines the schema and
redaction contract; users must explicitly opt in before anything can be sent to
a hosted endpoint.

## Consent levels

| Level | Behavior |
|---|---|
| `none` | No telemetry envelope is produced. |
| `aggregate` | Run-level metadata and finding outcome counts only. |
| `finding-metadata` | Adds redacted per-finding metadata such as stable id, severity, confidence, file extension, coarse line bucket, verdict, points, and evaluator type. |

## Blocked fields

Telemetry envelopes must not include raw code, raw diffs, raw prompts, raw file
paths, branch names, commit SHAs, secret-like values, author identities, PR
titles, model transcripts, URLs, or repository names. The redaction guard treats
camelCase, snake_case, kebab-case, and space-separated variants of blocked field
names the same way, so fields such as `rawDiff`, `raw diff`, `apiKey`,
`access_token`, `repository`, `title`, and `url` are all rejected.

The public helper in `src/telemetry/schema.ts` enforces this contract with
`assertTelemetryIsRedacted`.

## Schema version

Current schema version:

```txt
2026-06-14
```

The hosted backend should reject envelopes with unsupported schema versions.

## Example aggregate envelope

```json
{
  "schema_version": "2026-06-14",
  "consent_level": "aggregate",
  "source": "action",
  "run": {
    "elek_version": "1.2.3",
    "repository_visibility": "private",
    "provider": "deepseek",
    "model": "deepseek/deepseek-v4-pro",
    "review_strategy": "crosscheck",
    "duration_ms": 12300,
    "cost_usd": 0.012345,
    "finding_count": 2,
    "accepted_count": 1,
    "partial_count": 1,
    "rejected_count": 0,
    "unreviewed_count": 0,
    "inline_comments_posted": 2,
    "inline_comments_skipped": 1,
    "inline_comments_failed": 0
  }
}
```
