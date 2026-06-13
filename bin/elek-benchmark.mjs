#!/usr/bin/env node
import { readFileSync } from "fs";
import { stringify as stringifyYaml } from "yaml";

class UsageError extends Error {}

// Keep suggested keywords specific enough that generated cases are useful drafts.
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "before",
  "being",
  "but",
  "can",
  "cannot",
  "could",
  "for",
  "from",
  "has",
  "have",
  "into",
  "not",
  "only",
  "that",
  "the",
  "their",
  "there",
  "this",
  "was",
  "will",
  "with",
  "would",
  "you",
]);

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: elek-benchmark [--id case-id] [--max-false-positives n] [--clean] summary.json

Creates an editable elek-eval benchmark suite from a saved elek-review-summary.json.

Options:
  --id <case-id>              Case id. Defaults to repository and entity number.
  --max-false-positives <n>   Allowed unmatched findings. Defaults to 0.
  --clean                     Emit a no-finding benchmark case.
  -h, --help                  Show this help.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { id: "", maxFalsePositives: 0, clean: false, summaryPath: "" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--clean") {
      args.clean = true;
    } else if (arg === "--id") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new UsageError("--id requires a case id");
      args.id = value;
    } else if (arg === "--max-false-positives") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) {
        throw new UsageError("--max-false-positives requires a non-negative integer");
      }
      args.maxFalsePositives = parseNonNegativeInteger(value, "--max-false-positives");
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else if (!args.summaryPath) {
      args.summaryPath = arg;
    } else {
      throw new UsageError("only one summary JSON path is supported");
    }
  }
  if (!args.summaryPath) throw new UsageError("summary JSON path is required");
  return args;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${label} requires a non-negative integer`);
  }
  return parsed;
}

function readSummary(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeFindings(summary) {
  if (Array.isArray(summary.findings)) return summary.findings;
  if (Array.isArray(summary.review?.findings)) return summary.review.findings;
  return [];
}

function buildCase(summary, args) {
  const repository = String(summary.repository ?? "");
  const number = summary.entity?.number;
  if (!repository) throw new Error("summary is missing repository");
  if (number === undefined || number === null || number === "") {
    throw new Error("summary is missing entity.number");
  }
  const numericNumber = Number(number);
  if (!Number.isInteger(numericNumber) || numericNumber < 0) {
    throw new Error("summary.entity.number must be a non-negative integer");
  }

  const usedFindingIds = new Set();
  const testCase = {
    id: args.id || slug(`${repository}-${number}`),
    repository,
    number: numericNumber,
    expected_findings: args.clean
      ? []
      : normalizeFindings(summary).map((finding, index) =>
        expectedFinding(finding, index, usedFindingIds)),
    max_false_positives: args.maxFalsePositives,
  };

  return {
    version: 1,
    cases: [testCase],
  };
}

function expectedFinding(finding, index, usedIds) {
  const title = String(finding.title ?? `finding-${index + 1}`);
  const baseId = slug(title) || `finding-${index + 1}`;
  const expected = {
    id: uniqueId(baseId, usedIds, index),
    keywords: suggestKeywords(finding),
  };
  const minSeverity = normalizeSeverity(finding.severity);
  if (minSeverity) expected.min_severity = minSeverity;
  return expected;
}

function uniqueId(baseId, usedIds, index) {
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }
  let suffix = index + 1;
  let candidate = `${baseId}-${suffix}`;
  while (usedIds.has(candidate)) {
    suffix++;
    candidate = `${baseId}-${suffix}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizeSeverity(value) {
  const severity = String(value ?? "").toLowerCase();
  return ["minor", "important", "critical"].includes(severity) ? severity : undefined;
}

function suggestKeywords(finding) {
  const source = [
    finding.title,
    finding.path,
    finding.evidence,
    finding.impact,
    finding.fix,
  ].filter(Boolean).join(" ");
  const words = source
    .toLowerCase()
    .match(/[a-z][a-z0-9_]{2,}/g) ?? [];
  const unique = [];
  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;
    if (unique.includes(word)) continue;
    unique.push(word);
    if (unique.length >= 3) break;
  }
  return unique.length > 0 ? unique : ["replace-me"];
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const suite = buildCase(readSummary(args.summaryPath), args);
  process.stdout.write(stringifyYaml(suite) + "\n");
} catch (err) {
  process.stderr.write(`elek-benchmark: ${err.message}\n`);
  if (err instanceof UsageError) usage(1);
  process.exit(1);
}
