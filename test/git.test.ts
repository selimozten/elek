import { describe, expect, it } from "bun:test";
import { getGitDiff, isSafeGitRefName } from "../src/github/git";

describe("isSafeGitRefName", () => {
  it("allows ordinary GitHub branch refs", () => {
    expect(isSafeGitRefName("main")).toBe(true);
    expect(isSafeGitRefName("feature/payments-hardening")).toBe(true);
    expect(isSafeGitRefName("refs/pull/123/head")).toBe(true);
    expect(isSafeGitRefName("release/v1.2.3")).toBe(true);
  });

  it("rejects shell metacharacters and unsafe ref syntax", () => {
    expect(isSafeGitRefName("feature/$(touch${IFS}/tmp/elek-pwned)")).toBe(false);
    expect(isSafeGitRefName("feature/`touch /tmp/elek-pwned`")).toBe(false);
    expect(isSafeGitRefName("feature/ok;touch-pwned")).toBe(false);
    expect(isSafeGitRefName("-upload-pack=touch-pwned")).toBe(false);
    expect(isSafeGitRefName("feature/../../main")).toBe(false);
    expect(isSafeGitRefName("feature/@{upstream}")).toBe(false);
  });

  it("rejects malicious diff refs before invoking git", () => {
    expect(() => getGitDiff("main", "feature/$(touch${IFS}/tmp/elek-pwned)")).toThrow("Unsafe head ref");
  });
});
