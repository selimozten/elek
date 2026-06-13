#!/usr/bin/env node
import { readFileSync } from "fs";

const GROUP_KEYS = new Set(["strategy", "model", "repository"]);

class UsageError extends Error {}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: elek-analytics [--group-by strategy|model|repository] [--json] summary.json [...summary.json]

Aggregates saved elek-review-summary.json files into review quality, speed, and cost metrics.

Options:
  --group-by <key>   Group rows by strategy, model, or repository. Default: strategy.
  --json             Emit machine-readable JSON.
  -h, --help         Show this help.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { groupBy: "strategy", json: false, summaries: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--group-by") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new UsageError("--group-by requires a key");
      if (!GROUP_KEYS.has(value)) {
        throw new UsageError("--group-by must be one of: strategy, model, repository");
      }
      args.groupBy = value;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      args.summaries.push(arg);
    }
  }
  if (args.summaries.length === 0) throw new UsageError("at least one summary JSON path is required");
  return args;
}

function readSummary(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function groupKey(summary, groupBy) {
  if (groupBy === "model") return clean(summary.review?.finalModel) || "(unknown)";
  if (groupBy === "repository") return clean(summary.repository) || "(unknown)";
  return clean(summary.review?.executedStrategy) || "(unknown)";
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function findingCount(summary) {
  if (Array.isArray(summary.findings)) return summary.findings.length;
  if (Array.isArray(summary.review?.findings)) return summary.review.findings.length;
  return 0;
}

function addSummary(group, summary) {
  const conclusion = clean(summary.run?.conclusion);
  group.runs++;
  if (conclusion === "success") group.successes++;
  if (conclusion === "failure") group.failures++;
  group.findings += findingCount(summary);
  group.inlinePosted += normalizeNumber(summary.inlineComments?.posted);
  group.inlineSkipped += normalizeNumber(summary.inlineComments?.skipped);
  group.inlineFailed += normalizeNumber(summary.inlineComments?.failed);
  group.costUsd += normalizeNumber(summary.cost?.usd);
  group.inputTokens += normalizeNumber(summary.cost?.inputTokens);
  group.outputTokens += normalizeNumber(summary.cost?.outputTokens);
  group.durationSeconds += normalizeNumber(summary.run?.durationSeconds);
}

function aggregate(summaries, groupBy) {
  const groups = new Map();
  for (const summary of summaries) {
    const key = groupKey(summary, groupBy);
    const group = groups.get(key) ?? emptyGroup(key);
    addSummary(group, summary);
    groups.set(key, group);
  }

  const rows = [...groups.values()]
    .map(finalizeGroup)
    .sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
  return {
    version: 1,
    groupBy,
    totals: finalizeGroup(rows.reduce((total, row) => addRow(total, row), emptyGroup("total"))),
    groups: rows,
  };
}

function emptyGroup(key) {
  return {
    key,
    runs: 0,
    successes: 0,
    failures: 0,
    findings: 0,
    inlinePosted: 0,
    inlineSkipped: 0,
    inlineFailed: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationSeconds: 0,
  };
}

function addRow(total, row) {
  total.runs += row.runs;
  total.successes += row.successes;
  total.failures += row.failures;
  total.findings += row.findings;
  total.inlinePosted += row.inlinePosted;
  total.inlineSkipped += row.inlineSkipped;
  total.inlineFailed += row.inlineFailed;
  total.costUsd += row.costUsd;
  total.inputTokens += row.inputTokens;
  total.outputTokens += row.outputTokens;
  total.durationSeconds += row.durationSeconds;
  return total;
}

function finalizeGroup(group) {
  return {
    key: group.key,
    runs: group.runs,
    successes: group.successes,
    failures: group.failures,
    successRate: group.runs === 0 ? 0 : round(group.successes / group.runs),
    findings: group.findings,
    findingsPerRun: group.runs === 0 ? 0 : round(group.findings / group.runs),
    inlinePosted: group.inlinePosted,
    inlineSkipped: group.inlineSkipped,
    inlineFailed: group.inlineFailed,
    costUsd: round(group.costUsd, 6),
    avgCostUsd: group.runs === 0 ? 0 : round(group.costUsd / group.runs, 6),
    inputTokens: group.inputTokens,
    outputTokens: group.outputTokens,
    durationSeconds: round(group.durationSeconds, 1),
    avgDurationSeconds: group.runs === 0 ? 0 : round(group.durationSeconds / group.runs, 1),
  };
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printTable(report) {
  const rows = [
    ["group", "runs", "success", "findings", "inline", "cost", "avg cost", "avg secs"],
    ...report.groups.map((group) => [
      group.key,
      String(group.runs),
      `${Math.round(group.successRate * 100)}%`,
      `${group.findings} (${group.findingsPerRun}/run)`,
      `${group.inlinePosted}/${group.inlineSkipped}/${group.inlineFailed}`,
      `$${group.costUsd.toFixed(6)}`,
      `$${group.avgCostUsd.toFixed(6)}`,
      String(group.avgDurationSeconds),
    ]),
    [
      "total",
      String(report.totals.runs),
      `${Math.round(report.totals.successRate * 100)}%`,
      `${report.totals.findings} (${report.totals.findingsPerRun}/run)`,
      `${report.totals.inlinePosted}/${report.totals.inlineSkipped}/${report.totals.inlineFailed}`,
      `$${report.totals.costUsd.toFixed(6)}`,
      `$${report.totals.avgCostUsd.toFixed(6)}`,
      String(report.totals.avgDurationSeconds),
    ],
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) {
    process.stdout.write(row.map((cell, column) => cell.padEnd(widths[column])).join("  ") + "\n");
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const summaries = args.summaries.map(readSummary);
  const report = aggregate(summaries, args.groupBy);
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printTable(report);
  }
} catch (err) {
  process.stderr.write(`elek-analytics: ${err.message}\n`);
  if (err instanceof UsageError) usage(1);
  process.exit(1);
}
