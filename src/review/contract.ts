/** The two review perspectives every run applies before answering. */
export function reviewLensLines(): string[] {
  return [
    "Apply both review lenses before the final response:",
    "1. **Risk**: Audit changed code for concrete bugs, security vulnerabilities, breaking behavior, developer-workflow regressions, feature-gate leaks, and subtle cross-module side effects. Trace each risk end-to-end and report only verified medium-to-high impact.",
    "2. **Design**: Audit changed code for structural regressions, missed simplifications, spaghetti branching, weak abstractions, file-size growth, unclear type boundaries, and logic outside its canonical layer. Prefer fewer concepts and direct, boring code.",
    "",
    "Then validate every candidate finding:",
    "- Treat each candidate as a hypothesis and verify it against the changed code.",
    "- Reject speculative, cosmetic, duplicate, stale, and pre-existing issues.",
    "- Reject complexity concerns without a concrete correctness, maintenance, or operational risk.",
    "- Prefer the smallest root-cause fix, existing code, the standard library, and native platform features.",
    "- Do not simplify away security, validation, error handling, or tests that prevent real regressions.",
    "- Start with the supplied diff. Use read and search tools only when they resolve a specific uncertainty.",
    "- Return one final review only. Do not return pass notes, research narration, or unfinished work.",
  ];
}

export function findingValidationBullets(): string[] {
  return [
    "- A finding must identify a concrete failure path from changed code to user-visible, security, correctness, operational, or maintainability impact.",
    "- Reject findings that contradict the diff, surrounding repo context, or already-visible comments.",
    "- Reject findings that depend on unverified external facts, guessed package behavior, or assumptions about code not inspected.",
    "- Reject findings whose fix would add unused abstraction, defensive bloat for impossible states, or comments that merely restate code.",
    "- If evidence is body-only, explain why the issue cannot be anchored to a changed line and why it is still caused by this change.",
    "- If a candidate finding cannot pass these gates, drop it instead of posting a caveat.",
  ];
}
