#!/usr/bin/env node
import { readFileSync } from "fs";

const VERDICTS = new Set(["accepted", "partial", "rejected", "unreviewed"]);

class UsageError extends Error {}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: elek-feedback --template summary.json
       elek-feedback --apply feedback.json summary.json

Creates or applies per-finding review feedback so analytics can compare model quality.

Options:
  --template <path>  Emit an editable finding feedback JSON template.
  --apply <path>     Apply a completed feedback JSON file to a summary and emit the merged summary JSON.
  -h, --help         Show this help.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { templatePath: "", applyPath: "", summaryPath: "" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--template") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new UsageError("--template requires a summary path");
      args.templatePath = value;
    } else if (arg === "--apply") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new UsageError("--apply requires a feedback path");
      args.applyPath = value;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      args.summaryPath = arg;
    }
  }
  if (args.templatePath && args.applyPath) throw new UsageError("choose either --template or --apply");
  if (!args.templatePath && !args.applyPath) throw new UsageError("--template or --apply is required");
  if (args.templatePath && args.summaryPath) throw new UsageError("--template accepts exactly one summary path");
  if (args.applyPath && !args.summaryPath) throw new UsageError("--apply requires a summary path");
  return args;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to read ${label} ${path}: ${err.message}`);
  }
}

function summaryFindings(summary) {
  return Array.isArray(summary.findings) ? summary.findings : [];
}

function findingsWithIds(summary) {
  const usedIds = new Map();
  return summaryFindings(summary).map((finding, index) => ({
    finding,
    id: uniqueFindingId(finding, index, usedIds),
  }));
}

function findingId(finding, index) {
  const existing = clean(finding.id);
  if (existing) return existing;
  const slug = clean(finding.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `finding-${index + 1}`;
}

function uniqueFindingId(finding, index, usedIds) {
  const baseId = findingId(finding, index);
  const count = usedIds.get(baseId) ?? 0;
  usedIds.set(baseId, count + 1);
  return count === 0 ? baseId : `${baseId}-${count}`;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function template(summary) {
  return {
    version: 1,
    summary: {
      repository: summary.repository ?? "",
      entityType: summary.entity?.type ?? "",
      number: summary.entity?.number ?? "",
      model: summary.review?.finalModel ?? "",
      strategy: summary.review?.executedStrategy ?? "",
      generatedAt: summary.generatedAt ?? "",
    },
    evaluator: "",
    evaluatedAt: new Date().toISOString(),
    scale: {
      points: "0-5",
      guidance: "5 accepted high-value finding, 3 partial/useful but incomplete, 0 rejected or not actionable",
    },
    findings: findingsWithIds(summary).map(({ finding, id }) => ({
      id,
      title: clean(finding.title),
      severity: clean(finding.severity) || "unknown",
      confidence: clean(finding.confidence) || "unknown",
      path: clean(finding.path),
      line: clean(finding.line),
      verdict: "unreviewed",
      points: 0,
      note: "",
    })),
  };
}

function applyFeedback(summary, feedback) {
  const entries = Array.isArray(feedback.findings) ? feedback.findings : [];
  const feedbackById = new Map(entries.map((entry) => [clean(entry.id), entry]).filter(([id]) => id));
  const evaluator = clean(feedback.evaluator);
  const evaluatedAt = clean(feedback.evaluatedAt) || new Date().toISOString();
  return {
    ...summary,
    findings: findingsWithIds(summary).map(({ finding, id }) => {
      const entry = feedbackById.get(id);
      return {
        ...finding,
        id,
        feedback: entry ? normalizeFeedback(entry, evaluator, evaluatedAt) : finding.feedback,
      };
    }),
  };
}

function normalizeFeedback(entry, evaluator, evaluatedAt) {
  const verdict = clean(entry.verdict).toLowerCase();
  if (!VERDICTS.has(verdict)) {
    throw new Error(`finding ${clean(entry.id) || "(unknown)"} has invalid verdict: ${entry.verdict}`);
  }
  const points = Number(entry.points);
  if (!Number.isFinite(points) || points < 0 || points > 5) {
    throw new Error(`finding ${clean(entry.id) || "(unknown)"} points must be between 0 and 5`);
  }
  return {
    verdict,
    points: round(points),
    evaluator,
    evaluatedAt,
    note: clean(entry.note),
  };
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const output = args.templatePath
    ? template(readJson(args.templatePath, "summary"))
    : applyFeedback(readJson(args.summaryPath, "summary"), readJson(args.applyPath, "feedback"));
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
} catch (err) {
  process.stderr.write(`elek-feedback: ${err.message}\n`);
  if (err instanceof UsageError) usage(1);
  process.exit(1);
}
