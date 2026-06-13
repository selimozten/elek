#!/usr/bin/env node
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

const SEVERITY_RANK = { unknown: 0, minor: 1, important: 2, critical: 3 };

class UsageError extends Error {}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: elek-eval --suite benchmark.yml [--case case-id] [--json] summary.json [...summary.json]

Scores saved elek-review-summary.json files against seeded expected findings.

Suite format:
  version: 1
  cases:
    - id: auth-regression
      repository: owner/repo
      number: 42
      expected_findings:
        - id: tenant-bypass
          min_severity: critical
          keywords: [tenant, session, bypass]
      max_false_positives: 0

Options:
  --suite <path>   Benchmark YAML file.
  --case <id>      Force all summaries to score against one case.
  --json           Emit machine-readable JSON.
  -h, --help       Show this help.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { suitePath: "", caseId: "", json: false, summaries: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--suite") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new UsageError("--suite requires a path");
      args.suitePath = value;
    } else if (arg === "--case") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new UsageError("--case requires a case id");
      args.caseId = value;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      args.summaries.push(arg);
    }
  }
  if (!args.suitePath) throw new UsageError("--suite is required");
  if (args.summaries.length === 0) throw new UsageError("at least one summary JSON path is required");
  return args;
}

function readYaml(path) {
  const data = parseYaml(readFileSync(path, "utf8"));
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  if (cases.length === 0) throw new Error("suite must contain at least one case");
  return { version: data?.version ?? 1, cases };
}

function readSummary(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function summaryCase(summary, suite, forcedCaseId) {
  if (forcedCaseId) {
    const forced = suite.cases.find((entry) => entry.id === forcedCaseId);
    if (!forced) throw new Error(`case not found in suite: ${forcedCaseId}`);
    return forced;
  }
  const repository = summary.repository;
  const number = summary.entity?.number;
  return suite.cases.find((entry) => entry.repository === repository && Number(entry.number) === Number(number));
}

function normalizeFindings(summary) {
  const findings = Array.isArray(summary.findings)
    ? summary.findings
    : Array.isArray(summary.review?.findings)
      ? summary.review.findings
      : [];
  return findings.map((finding) => ({
    title: String(finding.title ?? ""),
    severity: String(finding.severity ?? "unknown").toLowerCase(),
    confidence: String(finding.confidence ?? "unknown").toLowerCase(),
    path: String(finding.path ?? ""),
    line: String(finding.line ?? ""),
    text: [
      finding.title,
      finding.path,
      finding.line,
      finding.evidence,
      finding.impact,
      finding.fix,
    ].filter(Boolean).join(" ").toLowerCase(),
  }));
}

function expectedFindings(testCase) {
  return Array.isArray(testCase.expected_findings)
    ? testCase.expected_findings
    : Array.isArray(testCase.expectedFindings)
      ? testCase.expectedFindings
      : [];
}

function severityPasses(actual, minimum) {
  if (!minimum) return true;
  return (SEVERITY_RANK[actual] ?? 0) >= (SEVERITY_RANK[String(minimum).toLowerCase()] ?? 0);
}

function findingMatches(finding, expected) {
  const keywords = Array.isArray(expected.keywords) ? expected.keywords : [];
  if (keywords.length === 0) return false;
  if (!severityPasses(finding.severity, expected.min_severity ?? expected.minSeverity ?? expected.severity)) {
    return false;
  }
  return keywords.every((keyword) => keywordMatches(finding.text, String(keyword)));
}

function keywordMatches(text, keyword) {
  const normalized = keyword.toLowerCase().trim();
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`, "i").test(text);
}

function scoreSummary(summary, testCase, path) {
  const findings = normalizeFindings(summary);
  const expected = expectedFindings(testCase);
  const usedFindingIndexes = new Set();
  const matches = [];

  for (const expectedFinding of expected) {
    const matchedIndex = findings.findIndex((finding, index) =>
      !usedFindingIndexes.has(index) && findingMatches(finding, expectedFinding));
    if (matchedIndex >= 0) {
      usedFindingIndexes.add(matchedIndex);
      matches.push({ expectedId: expectedFinding.id ?? "", findingTitle: findings[matchedIndex].title });
    }
  }

  const falsePositives = findings.filter((_, index) => !usedFindingIndexes.has(index));
  const recall = expected.length === 0 ? 1 : matches.length / expected.length;
  const precision = findings.length === 0 ? (expected.length === 0 ? 1 : 0) : matches.length / findings.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const maxFalsePositives = Number(testCase.max_false_positives ?? testCase.maxFalsePositives ?? 0);

  return {
    path,
    caseId: testCase.id ?? "",
    repository: summary.repository ?? "",
    number: summary.entity?.number ?? "",
    model: summary.review?.finalModel ?? "",
    strategy: summary.review?.executedStrategy ?? "",
    expected: expected.length,
    matched: matches.length,
    missed: expected.length - matches.length,
    findings: findings.length,
    falsePositives: falsePositives.length,
    maxFalsePositives,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    costUsd: Number(summary.cost?.usd ?? 0),
    durationSeconds: Number(summary.run?.durationSeconds ?? 0),
    passed: matches.length === expected.length && falsePositives.length <= maxFalsePositives,
    matches,
    falsePositiveTitles: falsePositives.map((finding) => finding.title),
  };
}

function aggregate(results) {
  const totalExpected = results.reduce((sum, result) => sum + result.expected, 0);
  const totalMatched = results.reduce((sum, result) => sum + result.matched, 0);
  const totalFindings = results.reduce((sum, result) => sum + result.findings, 0);
  const totalCostUsd = results.reduce((sum, result) => sum + result.costUsd, 0);
  const totalDurationSeconds = results.reduce((sum, result) => sum + result.durationSeconds, 0);
  const recall = totalExpected === 0 ? 1 : totalMatched / totalExpected;
  const precision = totalFindings === 0 ? (totalExpected === 0 ? 1 : 0) : totalMatched / totalFindings;
  return {
    passed: results.every((result) => result.passed),
    cases: results.length,
    expected: totalExpected,
    matched: totalMatched,
    findings: totalFindings,
    falsePositives: results.reduce((sum, result) => sum + result.falsePositives, 0),
    precision: round(precision),
    recall: round(recall),
    f1: round(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)),
    costUsd: round(totalCostUsd, 6),
    durationSeconds: round(totalDurationSeconds, 1),
  };
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printTable(results, totals) {
  const rows = [
    ["case", "model", "strategy", "recall", "precision", "fp", "cost", "secs", "status"],
    ...results.map((result) => [
      result.caseId,
      result.model,
      result.strategy,
      `${result.matched}/${result.expected}`,
      String(result.precision),
      `${result.falsePositives}/${result.maxFalsePositives}`,
      `$${result.costUsd.toFixed(6)}`,
      String(result.durationSeconds),
      result.passed ? "pass" : "fail",
    ]),
    [
      "total",
      "",
      "",
      `${totals.matched}/${totals.expected}`,
      String(totals.precision),
      String(totals.falsePositives),
      `$${totals.costUsd.toFixed(6)}`,
      String(totals.durationSeconds),
      totals.passed ? "pass" : "fail",
    ],
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) {
    process.stdout.write(row.map((cell, column) => cell.padEnd(widths[column])).join("  ") + "\n");
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const suite = readYaml(args.suitePath);
  const results = args.summaries.map((path) => {
    const summary = readSummary(path);
    const testCase = summaryCase(summary, suite, args.caseId);
    if (!testCase) throw new Error(`no suite case matches ${path}; add repository/number or pass --case`);
    return scoreSummary(summary, testCase, path);
  });
  const totals = aggregate(results);
  if (args.json) {
    process.stdout.write(JSON.stringify({ version: 1, totals, results }, null, 2) + "\n");
  } else {
    printTable(results, totals);
  }
  process.exit(totals.passed ? 0 : 1);
} catch (err) {
  process.stderr.write(`elek-eval: ${err.message}\n`);
  if (err instanceof UsageError) usage(1);
  process.exit(1);
}
