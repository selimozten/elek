/**
 * Tests for progressive comment formatting.
 * Pure formatting logic — no pi, no GitHub, no API keys needed.
 */
import { describe, it, expect } from "bun:test";
import { formatProgressComment } from "../src/github/progress";

describe("formatProgressComment", () => {
  const modelLabel = "deepseek/deepseek-v4-pro";
  const link = "[View run](https://github.com/foo/bar/actions/runs/1)";

  it("shows initial checklist with nothing checked", () => {
    const body = formatProgressComment(
      { readContext: false, analyzed: false, wroteReview: false, lastTool: "" },
      modelLabel,
      link,
    );

    expect(body).toContain("- [ ] Reading context…");
    expect(body).toContain("- [ ] Analyzing");
    expect(body).toContain("- [ ] Writing review");
    expect(body).not.toContain("[x]");
  });

  it("checks off reading when tool runs", () => {
    const body = formatProgressComment(
      { readContext: true, analyzed: false, wroteReview: false, lastTool: "Read" },
      modelLabel,
      link,
    );

    expect(body).toContain("- [x] Read context");
    expect(body).toContain("Analyzing (Read)…");
    expect(body).toContain("- [ ] Writing review");
  });

  it("shows current tool name during analyze phase", () => {
    const body = formatProgressComment(
      { readContext: true, analyzed: false, wroteReview: false, lastTool: "Bash(npm test)" },
      modelLabel,
      link,
    );

    expect(body).toContain("Analyzing (Bash(npm test))…");
  });

  it("checks off analyzing and shows writing phase", () => {
    const body = formatProgressComment(
      { readContext: true, analyzed: true, wroteReview: false, lastTool: "Grep" },
      modelLabel,
      link,
    );

    expect(body).toContain("- [x] Read context");
    expect(body).toContain("- [x] Analyzed code");
    expect(body).toContain("Writing review…");
  });

  it("all three checked when review written", () => {
    const body = formatProgressComment(
      { readContext: true, analyzed: true, wroteReview: true, lastTool: "" },
      modelLabel,
      link,
    );

    expect(body).toContain("- [x] Read context");
    expect(body).toContain("- [x] Analyzed code");
    expect(body).toContain("- [x] Review complete");
  });

  it("includes job run link at bottom", () => {
    const body = formatProgressComment(
      { readContext: false, analyzed: false, wroteReview: false, lastTool: "" },
      modelLabel,
      link,
    );

    expect(body).toContain(link);
  });
});
