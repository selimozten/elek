export interface ChangedFilePatch {
  path: string;
  oldPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

const MIN_FILE_SLICE_CHARS = 700;
const MAX_FILE_SLICE_CHARS = 64_000;
const DEFAULT_MODEL_INPUT_BUDGET_CHARS = 320_000;
const MIN_DIFF_PROMPT_CHARS = 8_000;

export const DEFAULT_REVIEW_PATCH_OMIT_PATTERNS = [
  "**/*.snap",
  "**/__snapshots__/**",
  "**/*.generated.*",
  "**/*.gen.*",
  "**/generated/**",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

interface DiffPromptOptions {
  omitPatchPatterns?: string[];
}

/**
 * Approximate full-input budgets after reserving model output and provider
 * framing. Code-heavy prompts average about three characters per token.
 */
export function modelInputBudgetChars(modelLabel: string): number {
  const normalized = modelLabel.toLowerCase();
  if (/kimi[-_.]?k3/.test(normalized)) return 2_700_000;
  if (/gpt[-_.]?5[.-]?6/.test(normalized)) return 700_000;
  if (/glm[-_.]?5[.-]?2/.test(normalized)) return 540_000;
  return DEFAULT_MODEL_INPUT_BUDGET_CHARS;
}

export function diffPromptBudgetChars(modelLabel: string, reservedChars = 0): number {
  return Math.max(MIN_DIFF_PROMPT_CHARS, modelInputBudgetChars(modelLabel) - Math.max(0, reservedChars));
}

export function parseUnifiedDiffFiles(diff: string): ChangedFilePatch[] {
  const starts = [...diff.matchAll(/^diff --git .+$/gm)].map((match) => match.index ?? 0);
  if (starts.length === 0) return [];

  const files: ChangedFilePatch[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1] ?? diff.length;
    const patch = diff.slice(start, end).replace(/\n+$/, "");
    const firstLine = patch.split("\n", 1)[0] ?? "";
    const { oldPath, newPath } = parseDiffHeader(firstLine);
    const status = patch.includes("\ndeleted file mode ")
      ? "deleted"
      : patch.includes("\nnew file mode ")
        ? "added"
        : patch.includes("\nrename from ") || patch.includes("\nrename to ")
          ? "renamed"
          : "modified";
    const counts = countPatchChanges(patch);
    files.push({
      path: status === "deleted" ? oldPath : newPath,
      oldPath,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      patch,
    });
  }
  return files;
}

export function formatChangedFilesForPrompt(
  diff: string | undefined,
  maxChars = DEFAULT_MODEL_INPUT_BUDGET_CHARS,
  options: DiffPromptOptions = {},
): string {
  if (!diff) return "(diff unavailable; inspect files from the workspace if needed)";

  const files = parseUnifiedDiffFiles(diff);
  if (files.length === 0) return fallbackTruncatedDiff(diff, maxChars);

  const overview = formatFileOverview(files);
  const omittedPatchFiles = files.filter((file) =>
    options.omitPatchPatterns?.some((pattern) => matchesPathPattern(file.path, pattern)),
  );
  const reviewFiles = files.filter((file) => !omittedPatchFiles.includes(file));
  const omittedPatchNote = omittedPatchFiles.length > 0
    ? `\n\n# ${omittedPatchFiles.length} patch bodies omitted as configured or generated noise; paths remain in the overview.`
    : "";
  const reviewDiff = reviewFiles.map((file) => file.patch).join("\n");
  const fullDiffWithOverview = `${overview}${omittedPatchNote}\n\n# Full diff\n${reviewDiff}`;
  if (fullDiffWithOverview.length <= maxChars) {
    return fullDiffWithOverview;
  }

  const sorted = [...reviewFiles].sort(comparePromptPriority);
  const remainingBudget = Math.max(0, maxChars - overview.length - omittedPatchNote.length - 1_200);
  const perFileBudget = Math.max(
    MIN_FILE_SLICE_CHARS,
    Math.min(MAX_FILE_SLICE_CHARS, Math.floor(remainingBudget / Math.max(1, Math.min(reviewFiles.length, 40)))),
  );

  const blocks: string[] = [
    overview,
    ...(omittedPatchNote ? [omittedPatchNote.trim()] : []),
    "",
    "# Representative diff slices",
    "# Slices are prioritized toward non-deleted production files so later application changes are not starved by early docs/workflow churn.",
  ];
  const included = new Set<string>();
  let omitted = 0;

  for (const file of sorted) {
    const slice = slicePatch(file.patch, perFileBudget);
    const header = `\n# ${file.path} (${file.status}, +${file.additions}/-${file.deletions})\n`;
    const block = `${header}${slice}`;
    const nextLength = blocks.join("\n").length + block.length + 240;
    if (nextLength > maxChars) {
      omitted++;
      continue;
    }
    blocks.push(block);
    included.add(file.path);
  }

  omitted = reviewFiles.length - included.size;
  if (omitted > 0) {
    blocks.push("");
    blocks.push(`# ... ${omitted} changed file(s) omitted from diff slices; see the full file overview above and inspect files with read/grep/find/ls as needed.`);
  }
  blocks.push("");
  blocks.push(`# ... diff truncated by file for prompt budget; original diff was ${diff.length.toLocaleString("en-US")} characters.`);

  return blocks.join("\n").slice(0, maxChars);
}

function matchesPathPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const target = normalizedPattern.includes("/")
    ? normalizedPath
    : normalizedPath.split("/").at(-1) || normalizedPath;
  let source = "";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index]!;
    const next = normalizedPattern[index + 1];
    const afterNext = normalizedPattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$+?.()|{}[]".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`).test(target);
}

function parseDiffHeader(line: string): { oldPath: string; newPath: string } {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return { oldPath: "(unknown)", newPath: "(unknown)" };
  return { oldPath: unquotePath(match[1]), newPath: unquotePath(match[2]) };
}

function unquotePath(path: string): string {
  return path.replace(/^"|"$/g, "");
}

function countPatchChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function formatFileOverview(files: ChangedFilePatch[]): string {
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = [
    `# Changed file overview (${files.length} file${files.length === 1 ? "" : "s"}, +${totalAdditions}/-${totalDeletions})`,
    ...files.map((file) => `# - ${file.path} (${file.status}, +${file.additions}/-${file.deletions})`),
  ];
  return lines.join("\n");
}

function comparePromptPriority(a: ChangedFilePatch, b: ChangedFilePatch): number {
  const score = promptPriority(a) - promptPriority(b);
  if (score !== 0) return score;
  const churn = (b.additions + b.deletions) - (a.additions + a.deletions);
  if (churn !== 0) return churn;
  return a.path.localeCompare(b.path);
}

function promptPriority(file: ChangedFilePatch): number {
  const nonCode = isDocsOrWorkflow(file.path);
  if (file.status === "deleted" && nonCode) return 6;
  if (file.status === "deleted") return 5;
  if (isProductionCode(file.path)) return 0;
  if (isTestCode(file.path)) return 1;
  if (nonCode) return 4;
  return 2;
}

function isDocsOrWorkflow(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith(".github/") ||
    lower.startsWith("docs/") ||
    lower === "readme.md" ||
    lower.startsWith("readme.") ||
    lower.startsWith("changelog.") ||
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.endsWith(".rst") ||
    lower.endsWith(".adoc")
  );
}

function isProductionCode(path: string): boolean {
  const lower = path.toLowerCase();
  if (isTestCode(lower) || isDocsOrWorkflow(lower)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|go|rs|py|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|ex|exs|erl|hrl|sql)$/.test(lower);
}

function isTestCode(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("__tests__/") ||
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.endsWith("_test.go")
  );
}

function slicePatch(patch: string, maxChars: number): string {
  if (patch.length <= maxChars) return patch;
  const slice = patch.slice(0, Math.max(0, maxChars - 140)).replace(/\n[^\n]*$/, "");
  return `${slice}\n# ... file diff truncated; inspect this file directly if it is relevant.`;
}

function fallbackTruncatedDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, Math.max(0, maxChars - 120))}\n\n... diff truncated for prompt budget; use read/grep/find/ls tools for more context.`;
}
