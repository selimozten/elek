import { describe, expect, it } from "bun:test";
import { sanitize } from "../src/review/host-output";

describe("sanitize", () => {
  it.each([
    ["github token", `ghp_${"a".repeat(36)}`],
    ["fine-grained github token", `github_pat_${"A1_".repeat(10)}`],
    ["sk- api key", `sk-${"x".repeat(32)}`],
    ["google api key", `AIza${"b".repeat(35)}`],
    ["aws access key id", "AKIAABCDEFGHIJKLMNOP"],
    ["jwt", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlMTIz"],
  ])("redacts a %s", (_label, secret) => {
    expect(sanitize(`leaked ${secret} here`)).toBe("leaked [REDACTED] here");
  });

  it("keeps commit SHAs and email-like examples in review prose", () => {
    const prose = "Commit 0123456789abcdef0123456789abcdef01234567 emails user@example.com.";
    expect(sanitize(prose)).toBe(prose);
  });
});
