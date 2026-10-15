import { describe, expect, it } from "bun:test";
import { findingValidationBullets, reviewLensLines } from "../src/review/contract";

describe("review finding contract", () => {
  it("applies the risk and design lenses, then validates candidates", () => {
    const lines = reviewLensLines().join("\n");

    expect(lines).toContain("1. **Risk**: Audit changed code for concrete bugs, security vulnerabilities");
    expect(lines).toContain("2. **Design**: Audit changed code for structural regressions");
    expect(lines).toContain("- Treat each candidate as a hypothesis and verify it against the changed code.");
    expect(lines).toContain("Use read and search tools only when they resolve a specific uncertainty.");
  });

  it("defines validation gates that reject unverifiable findings", () => {
    expect(findingValidationBullets()).toEqual([
      "- A finding must identify a concrete failure path from changed code to user-visible, security, correctness, operational, or maintainability impact.",
      "- Reject findings that contradict the diff, surrounding repo context, or already-visible comments.",
      "- Reject findings that depend on unverified external facts, guessed package behavior, or assumptions about code not inspected.",
      "- Reject findings whose fix would add unused abstraction, defensive bloat for impossible states, or comments that merely restate code.",
      "- If evidence is body-only, explain why the issue cannot be anchored to a changed line and why it is still caused by this change.",
      "- If a candidate finding cannot pass these gates, drop it instead of posting a caveat.",
    ]);
  });
});
