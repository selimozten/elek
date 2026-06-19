export interface ChangedFilePatch {
  path: string;
  oldPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

const MAX_OVERVIEW_FILES = 250;
const MIN_FILE_SLICE_CHARS = 700;
const MAX_FILE_SLICE_CHARS = 4_000;
const DEFAULT_FULL_DIFF_THRESHOLD_CHARS = 80_000;

export interface DiffPromptOptions {
  /**
   * Full diffs larger than this use representative slices. The hard maxChars
   * remains the absolute ceiling; this threshold keeps model behavior tool-first.
   */
  fullDiffThresholdChars?: number;
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
  maxChars = 200_000,
  options: DiffPromptOptions = {},
): string {
  if (!diff) return "(diff unavailable; inspect files from the workspace if needed)";

  const files = parseUnifiedDiffFiles(diff);
  if (files.length === 0) return fallbackTruncatedDiff(diff, maxChars);

  const overview = formatFileOverview(files);
  const fullDiffWithOverview = `${overview}\n\n# Full diff\n${diff}`;
  const fullDiffThreshold = options.fullDiffThresholdChars ?? DEFAULT_FULL_DIFF_THRESHOLD_CHARS;
  if (
    fullDiffWithOverview.length <= maxChars &&
    fullDiffWithOverview.length <= fullDiffThreshold
  ) {
    return fullDiffWithOverview;
  }

  const sorted = [...files].sort(comparePromptPriority);
  const remainingBudget = Math.max(0, maxChars - overview.length - 1_200);
  const perFileBudget = Math.max(
    MIN_FILE_SLICE_CHARS,
    Math.min(MAX_FILE_SLICE_CHARS, Math.floor(remainingBudget / Math.max(1, Math.min(files.length, 40)))),
  );

  const blocks: string[] = [
    overview,
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

  omitted = files.length - included.size;
  if (omitted > 0) {
    blocks.push("");
    blocks.push(`# ... ${omitted} changed file(s) omitted from diff slices; see the full file overview above and inspect files with read/grep/find/ls as needed.`);
  }
  blocks.push("");
  blocks.push(`# ... diff truncated by file for prompt budget; original diff was ${diff.length.toLocaleString("en-US")} characters.`);

  return blocks.join("\n").slice(0, maxChars);
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
  const shown = files.slice(0, MAX_OVERVIEW_FILES);
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = [
    `# Changed file overview (${files.length} file${files.length === 1 ? "" : "s"}, +${totalAdditions}/-${totalDeletions})`,
    ...shown.map((file) => `# - ${file.path} (${file.status}, +${file.additions}/-${file.deletions})`),
  ];
  if (files.length > shown.length) {
    lines.push(`# - ... ${files.length - shown.length} more file(s)`);
  }
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
