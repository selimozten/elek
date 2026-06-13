#!/usr/bin/env node
import { readFileSync } from "fs";

const GROUP_KEYS = new Set(["strategy", "model", "repository"]);

class UsageError extends Error {}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: elek-analytics [--group-by strategy|model|repository] [--json] summary.json [...summary.json]
       elek-analytics [--group-by strategy|model|repository] [--json] --baseline old.json [...] --current new.json [...]

Aggregates saved elek-review-summary.json files into review quality, speed, and cost metrics.

Options:
  --group-by <key>   Group rows by strategy, model, or repository. Default: strategy.
  --baseline <path>  Add one or more baseline summary files for trend comparison.
  --current <path>   Add one or more current summary files for trend comparison.
  --json             Emit machine-readable JSON.
  -h, --help         Show this help.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { groupBy: "strategy", json: false, summaries: [], baseline: [], current: [] };
  let target = "summaries";
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
    } else if (arg === "--baseline") {
      target = "baseline";
    } else if (arg === "--current") {
      target = "current";
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      args[target].push(arg);
    }
  }
  const comparing = args.baseline.length > 0 || args.current.length > 0;
  if (comparing && args.summaries.length > 0) {
    throw new UsageError("do not mix positional summaries with --baseline/--current");
  }
  if (comparing && (args.baseline.length === 0 || args.current.length === 0)) {
    throw new UsageError("--baseline and --current both require at least one summary path");
  }
  if (!comparing && args.summaries.length === 0) {
    throw new UsageError("at least one summary JSON path is required");
  }
  return args;
}

function readSummary(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to read summary ${path}: ${err.message}`);
  }
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
  return 0;
}

function addSummary(group, summary) {
  const conclusion = clean(summary.run?.conclusion);
  group.runs++;
  if (conclusion === "success") group.successes++;
  else group.failures++;
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

function compareReports(baseline, current) {
  const baselineGroups = new Map(baseline.groups.map((group) => [group.key, group]));
  const currentGroups = new Map(current.groups.map((group) => [group.key, group]));
  const keys = [...new Set([...baselineGroups.keys(), ...currentGroups.keys()])].sort((a, b) => a.localeCompare(b));
  return {
    version: 1,
    groupBy: current.groupBy,
    baseline,
    current,
    comparisons: keys.map((key) => {
      const before = baselineGroups.get(key) ?? finalizeGroup(emptyGroup(key));
      const after = currentGroups.get(key) ?? finalizeGroup(emptyGroup(key));
      const delta = {
        runs: after.runs - before.runs,
        successRate: round(after.successRate - before.successRate),
        findingsPerRun: round(after.findingsPerRun - before.findingsPerRun),
        inlineIssueRate: round(inlineIssueRate(after) - inlineIssueRate(before)),
        avgCostUsd: round(after.avgCostUsd - before.avgCostUsd, 6),
        avgDurationSeconds: round(after.avgDurationSeconds - before.avgDurationSeconds, 1),
      };
      return {
        key,
        baseline: before,
        current: after,
        delta,
        regressions: describeRegressions(delta, before, after),
        changes: describeNotableChanges(delta, before, after),
      };
    }),
  };
}

function inlineIssueRate(group) {
  const total = group.inlinePosted + group.inlineSkipped + group.inlineFailed;
  return total === 0 ? 0 : (group.inlineSkipped + group.inlineFailed) / total;
}

function describeRegressions(delta, before, after) {
  const regressions = [];
  if (before.runs > 0 && after.runs > 0 && delta.successRate <= -0.05) {
    regressions.push(`success rate down ${formatPercent(Math.abs(delta.successRate))}`);
  }
  if (before.runs > 0 && after.runs > 0 && delta.inlineIssueRate >= 0.05) {
    regressions.push(`inline issue rate up ${formatPercent(delta.inlineIssueRate)}`);
  }
  if (before.runs > 0 && after.runs > 0 && meaningfulIncrease(before.avgDurationSeconds, after.avgDurationSeconds, 5, 0.2)) {
    regressions.push(`average latency up ${formatPlainSeconds(delta.avgDurationSeconds)}`);
  }
  if (before.runs > 0 && after.runs > 0 && meaningfulIncrease(before.avgCostUsd, after.avgCostUsd, 0.001, 0.2)) {
    regressions.push(`average cost up ${formatUsd(Math.abs(delta.avgCostUsd))}`);
  }
  return regressions;
}

function describeNotableChanges(delta, before, after) {
  const changes = [];
  if (before.runs > 0 && after.runs > 0 && Math.abs(delta.findingsPerRun) >= 1) {
    const direction = delta.findingsPerRun > 0 ? "up" : "down";
    changes.push(`finding volume ${direction} ${Math.abs(delta.findingsPerRun)}/run`);
  }
  return changes;
}

function meaningfulIncrease(before, after, absoluteFloor, ratioFloor) {
  if (before <= 0) return after >= absoluteFloor;
  const delta = after - before;
  return delta >= absoluteFloor && delta / before >= ratioFloor;
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

function formatPercent(value) {
  return `${Math.round(value * 100)} pts`;
}

function formatSignedPercent(value) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.round(Math.abs(value) * 100)} pts`;
}

function formatSeconds(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${round(value, 1)}s`;
}

function formatPlainSeconds(value) {
  return `${round(Math.abs(value), 1)}s`;
}

function formatUsd(value) {
  return `$${round(value, 6).toFixed(6)}`;
}

function formatSignedUsd(value) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${round(Math.abs(value), 6).toFixed(6)}`;
}

function printTable(report) {
  const rows = [
    ["group", "runs", "success", "findings", "posted/skip/fail", "cost", "avg cost", "avg secs"],
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

function printComparisonTable(report) {
  const rows = [
    ["group", "runs", "success", "findings/run", "inline issues", "avg cost", "avg secs", "changes"],
    ...report.comparisons.map((item) => [
      item.key,
      `${item.baseline.runs}->${item.current.runs}`,
      `${Math.round(item.current.successRate * 100)}% (${formatSignedPercent(item.delta.successRate)})`,
      `${item.current.findingsPerRun} (${signedNumber(item.delta.findingsPerRun)})`,
      `${Math.round(inlineIssueRate(item.current) * 100)}% (${formatSignedPercent(item.delta.inlineIssueRate)})`,
      `${formatUsd(item.current.avgCostUsd)} (${formatSignedUsd(item.delta.avgCostUsd)})`,
      `${item.current.avgDurationSeconds}s (${formatSeconds(item.delta.avgDurationSeconds)})`,
      comparisonNotes(item),
    ]),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) {
    process.stdout.write(row.map((cell, column) => cell.padEnd(widths[column])).join("  ") + "\n");
  }
}

function comparisonNotes(item) {
  const notes = [...item.regressions, ...item.changes];
  return notes.length === 0 ? "-" : notes.join("; ");
}

function signedNumber(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const comparing = args.baseline.length > 0 || args.current.length > 0;
  const report = comparing
    ? compareReports(
      aggregate(args.baseline.map(readSummary), args.groupBy),
      aggregate(args.current.map(readSummary), args.groupBy),
    )
    : aggregate(args.summaries.map(readSummary), args.groupBy);
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (comparing) {
    printComparisonTable(report);
  } else {
    printTable(report);
  }
} catch (err) {
  process.stderr.write(`elek-analytics: ${err.message}\n`);
  if (err instanceof UsageError) usage(1);
  process.exit(1);
}
