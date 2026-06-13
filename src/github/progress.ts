/**
 * Progressive comment formatting — generates dynamic checklist bodies
 * for step-by-step tracking comment updates during pi execution.
 */
import { spinnerHeader } from "./spinner";

export interface ProgressState {
  readContext: boolean;
  analyzed: boolean;
  wroteReview: boolean;
  lastTool: string;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

export function formatProgressComment(
  state: ProgressState,
  modelLabel: string,
  jobRunLink: string,
): string {
  const lines: string[] = [];

  lines.push(spinnerHeader(modelLabel));
  lines.push("");

  const check = (done: boolean) => (done ? "x" : " ");

  // Phase 1: Reading context
  if (!state.readContext && !state.analyzed && !state.wroteReview) {
    lines.push(`- [${check(state.readContext)}] Reading context…`);
  } else {
    lines.push(
      `- [${check(state.readContext)}] ${state.readContext ? "Read context" : "Reading context…"}`,
    );
  }

  // Phase 2: Analyzing (unlocked after read)
  if (state.readContext) {
    const lastTool = escapeMarkdown(state.lastTool);
    lines.push(
      `- [${check(state.analyzed)}] ${state.analyzed ? "Analyzed code" : `Analyzing (${lastTool})…`}`,
    );
  } else {
    lines.push(`- [ ] Analyzing`);
  }

  // Phase 3: Writing review (unlocked after analyze)
  if (state.analyzed) {
    lines.push(
      `- [${check(state.wroteReview)}] ${state.wroteReview ? "Review complete" : "Writing review…"}`,
    );
  } else {
    lines.push(`- [ ] Writing review`);
  }

  lines.push("");
  lines.push(jobRunLink);

  return lines.join("\n");
}
