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
});
