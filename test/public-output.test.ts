import { describe, expect, it } from "bun:test";
import { preparePublicReviewOutput } from "../src/review/public-output";

describe("public review output filtering", () => {
  it("replaces internal-only MCP delivery chatter with a generic public body", () => {
    const output = [
      "The `elek_review_*` MCP tools are now consistently returning a gateway-level validation error (`args: must be string`).",
      "",
      "Because the tool-call failure means console output is discarded, I cannot deliver the review.",
    ].join("\n");

    const result = preparePublicReviewOutput(output, "success");

    expect(result.usable).toBe(false);
    expect(result.filtered).toBe(true);
    expect(result.body).toContain("usable public review");
    expect(result.body).not.toContain("elek_review_");
    expect(result.body).not.toContain("args: must be string");
    expect(result.body).not.toContain("gateway");
  });

  it("keeps review findings while dropping operational delivery paragraphs", () => {
    const output = [
      "The mcp proxy failed to create an inline comment due to a transport error.",
      "",
      "## Review Summary",
      "The change introduces one tenant-isolation regression.",
      "",
      "### Missing tenant check",
      "- Severity: critical",
      "- Confidence: high",
      "- Path: `src/auth.ts`",
      "- Line: 42",
      "- Evidence: the new query omits tenant_id",
      "- Impact: users can see another tenant's data",
      "- Fix: add tenant_id to the lookup predicate",
    ].join("\n");

    const result = preparePublicReviewOutput(output, "success");

    expect(result.usable).toBe(true);
    expect(result.filtered).toBe(true);
    expect(result.body).toContain("### Missing tenant check");
    expect(result.body).not.toContain("mcp proxy failed");
    expect(result.body).not.toContain("transport error");
  });

  it("hides raw execution failure details from public comments", () => {
    const result = preparePublicReviewOutput(
      "Review execution failed: gateway timeout while updating tracking comment",
      "failure",
    );

    expect(result.usable).toBe(false);
    expect(result.body).toBe("Elek could not complete this review run. See the workflow logs for details.");
    expect(result.body).not.toContain("gateway timeout");
  });

  it("rejects thinking-style prose without review structure", () => {
    const result = preparePublicReviewOutput(
      [
        "I need to inspect the diff and reason through the risk areas.",
        "First I will consider the workflow files, then I will check the Go code.",
        "The final answer should mention anything I find.",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(false);
    expect(result.body).toContain("usable public review");
    expect(result.body).not.toContain("inspect the diff");
  });

  it("does not treat internal analysis headings as public review structure", () => {
    const result = preparePublicReviewOutput(
      [
        "## Analysis",
        "I need to inspect the changed files and then decide how to deliver comments.",
        "",
        "### Tool status",
        "The MCP call failed, so I should explain that in the final answer.",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(false);
    expect(result.body).toContain("usable public review");
    expect(result.body).not.toContain("## Analysis");
    expect(result.body).not.toContain("MCP call failed");
  });

  it("strips internal analysis headings before the actual review", () => {
    const result = preparePublicReviewOutput(
      [
        "## Analysis",
        "I have read the files and will now write the public comment.",
        "",
        "## Review Summary",
        "The change introduces one correctness issue.",
        "",
        "### Missing tenant check",
        "- Severity: critical",
        "- Confidence: high",
        "- Path: `src/auth.ts`",
        "- Line: 42",
        "- Evidence: the new query omits tenant_id",
        "- Impact: users can see another tenant's data",
        "- Fix: add tenant_id to the lookup predicate",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(true);
    expect(result.filtered).toBe(true);
    expect(result.body).toStartWith("## Review Summary");
    expect(result.body).not.toContain("## Analysis");
    expect(result.body).not.toContain("I have read the files");
  });

  it("keeps non-standard review category headings when finding fields provide structure", () => {
    const result = preparePublicReviewOutput(
      [
        "I have finished reviewing the change.",
        "",
        "## Security Concern",
        "",
        "### Missing input validation",
        "- Severity: important",
        "- Confidence: high",
        "- Path: `src/api.ts`",
        "- Line: 12",
        "- Evidence: the handler trusts raw input",
        "- Impact: malformed input can reach persistence",
        "- Fix: validate the request body before saving",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(true);
    expect(result.filtered).toBe(true);
    expect(result.body).toStartWith("## Security Concern");
    expect(result.body).not.toContain("finished reviewing");
  });

  it("keeps common non-standard review headings even with prose findings", () => {
    const result = preparePublicReviewOutput(
      [
        "## Code Health",
        "The update is coherent and I do not see a blocking correctness issue.",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(true);
    expect(result.filtered).toBe(false);
    expect(result.body).toContain("## Code Health");
  });

  it("drops leading self-narration before the public review body", () => {
    const result = preparePublicReviewOutput(
      [
        "I now have a thorough understanding of all the changed files. Let me compile my review.",
        "",
        "## Review Summary",
        "This PR has one correctness issue.",
        "",
        "### Missing tenant check",
        "- Severity: critical",
        "- Confidence: high",
        "- Path: `src/auth.ts`",
        "- Line: 42",
        "- Evidence: the new query omits tenant_id",
        "- Impact: users can see another tenant's data",
        "- Fix: add tenant_id to the lookup predicate",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(true);
    expect(result.filtered).toBe(true);
    expect(result.body).toStartWith("## Review Summary");
    expect(result.body).not.toContain("thorough understanding");
    expect(result.body).not.toContain("Let me compile");
  });

  it("still redacts token-shaped strings in public review text", () => {
    const result = preparePublicReviewOutput(
      [
        "## Review Summary",
        "A token was accidentally printed: ghp_AbCd1234567890123456EfGh",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(true);
    expect(result.body).toContain("[REDACTED]");
    expect(result.body).not.toContain("ghp_AbCd");
  });

  it("strips model-generated cost and run footers from usable review output", () => {
    const result = preparePublicReviewOutput(
      [
        "## Review Summary",
        "No new findings that meet the acceptance gates.",
        "",
        "_Review cost: $0.0051 (1,553 in / 4,891 out tokens)_",
        "",
        "[View run](https://github.com/selimozten/elek/actions/runs/27787137042)",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(true);
    expect(result.filtered).toBe(true);
    expect(result.body).toBe(
      [
        "## Review Summary",
        "No new findings that meet the acceptance gates.",
      ].join("\n"),
    );
  });

  it("strips combined host-managed footer paragraphs from model output", () => {
    const result = preparePublicReviewOutput(
      [
        "## Findings",
        "No high-confidence findings.",
        "",
        "_Estimated review cost: at least $0.0123 (20,845 in / 0 out tokens; missing price data for model)_",
        "[View run](https://github.com/selimozten/elek/actions/runs/27787137042)",
        "<!-- elek-bot:lane:aaaaaaaaaaaa -->",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(true);
    expect(result.filtered).toBe(true);
    expect(result.body).toBe(["## Findings", "No high-confidence findings."].join("\n"));
  });

  it("strips model-prefixed run footers from model output", () => {
    const result = preparePublicReviewOutput(
      [
        "## Review Summary",
        "No high-confidence findings.",
        "",
        "*deepseek/deepseek-v4-pro · [View run](https://github.com/selimozten/elek/actions/runs/27787137042)*",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(true);
    expect(result.filtered).toBe(true);
    expect(result.body).toBe(["## Review Summary", "No high-confidence findings."].join("\n"));
  });

  it("rejects review-looking output that claims a PR is safe to merge", () => {
    const result = preparePublicReviewOutput(
      [
        "## Review Summary",
        "No high-confidence findings. LGTM, safe to merge.",
      ].join("\n"),
      "success",
    );

    expect(result.usable).toBe(false);
    expect(result.filtered).toBe(true);
  });

  it("redacts configured internal model labels from public review text", () => {
    const result = preparePublicReviewOutput(
      [
        "## Review Summary",
        "The deepseek/deepseek-v4-pro review found no high-confidence findings from deepseek-v4-pro.",
      ].join("\n"),
      "success",
      {
        internalModelLabels: ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
        publicModelLabel: "elek",
      },
    );

    expect(result.usable).toBe(true);
    expect(result.body).toContain("elek review");
    expect(result.body).not.toContain("deepseek/deepseek-v4-pro");
    expect(result.body).not.toContain("deepseek-v4-pro");
  });

  it("normalizes the strict verdict format and enforces the host severity threshold", () => {
    const output = [
      "Verdict: approve-with-amendments — two findings need attention",
      "",
      "### 🟡 Important",
      "- `src/auth.ts:2` — the lookup omits tenant_id. Users can read another tenant's data.",
      "",
      "### 🟢 Nit",
      "- `src/auth.ts:2` — the local name is unclear. Maintenance is slightly harder.",
    ].join("\n");
    const diff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "@@ -1 +1,2 @@",
      " old",
      "+new",
    ].join("\n");

    const result = preparePublicReviewOutput(output, "success", {
      requireVerdictFormat: true,
      severityThreshold: "important",
      diff,
    });

    expect(result.usable).toBe(true);
    expect(result.body).toContain("Verdict: approve-with-amendments");
    expect(result.body).toContain("### 🟡 Important");
    expect(result.body).not.toContain("### 🟢 Nit");
  });

  it("rejects strict findings that do not cite a visible diff line", () => {
    const output = [
      "Verdict: request-changes — a blocking issue needs attention",
      "",
      "### 🔴 Blocker",
      "- `src/missing.ts:99` — an invented path is unsafe. The change can fail.",
    ].join("\n");
    const diff = "diff --git a/src/auth.ts b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new";

    const result = preparePublicReviewOutput(output, "success", {
      requireVerdictFormat: true,
      severityThreshold: "important",
      diff,
    });

    expect(result.usable).toBe(true);
    expect(result.filtered).toBe(true);
    expect(result.body).toBe("Verdict: approve — no Blocker or Important findings");
  });
});
