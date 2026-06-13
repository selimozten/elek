import { describe, expect, it } from "bun:test";
import { findingValidationBullets, reviewContractBullets, reviewFindingTemplate } from "../src/review/contract";

describe("review finding contract", () => {
  it("requires the core finding fields and filters low-confidence output", () => {
    const bullets = reviewContractBullets();

    expect(bullets).toContain("- Every finding must include severity, confidence, evidence, impact, and a concrete fix.");
    expect(bullets).toContain("- Severity must be one of: critical, important, minor.");
    expect(bullets).toContain("- Confidence must be high or medium. Do not surface low-confidence findings.");
    expect(bullets).toContain("- Fix must describe the smallest concrete change that would resolve the issue.");
  });

  it("provides a non-redundant finding template", () => {
    expect(reviewFindingTemplate()).toEqual([
      "### Short title",
      "- Severity: critical|important|minor",
      "- Confidence: high|medium",
      "- Path: `path/to/file`",
      '- Line: new-diff line number if known, otherwise "body-only"',
      "- Evidence: quote or summarize the concrete code path",
      "- Impact: what breaks or gets harder to maintain",
      "- Fix: the smallest concrete change required",
    ]);
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
