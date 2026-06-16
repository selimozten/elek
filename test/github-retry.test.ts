/**
 * Tests for the GitHub API retry/backoff wrapper. A fake GitHub call fails
 * N times then succeeds; tests inject a 0-delay sleep + 0 jitter so they run
 * instantly. Asserts: retries on 429/503, honors Retry-After, gives up after
 * max attempts, and does NOT retry on terminal 4xx (404/422).
 */
import { describe, expect, it } from "bun:test";
import { parseRetryAfterMs, withGitHubRetry } from "../src/github/retry";

/** Build an Octokit-shaped error with a given HTTP status + optional headers. */
function httpError(status: number, headers?: Record<string, string>): Error {
  const err = new Error(`HTTP ${status}`) as Error & {
    status: number;
    response?: { status: number; headers?: Record<string, string> };
  };
  err.status = status;
  err.response = { status, headers };
  return err;
}

const fast = { baseDelayMs: 0, sleep: async () => {}, random: () => 0, log: () => {} };

describe("withGitHubRetry", () => {
  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const result = await withGitHubRetry(async () => {
      calls++;
      if (calls < 3) throw httpError(429);
      return "ok";
    }, fast);

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries on 503 then succeeds", async () => {
    let calls = 0;
    const result = await withGitHubRetry(async () => {
      calls++;
      if (calls < 2) throw httpError(503);
      return { data: [] };
    }, fast);

    expect(result).toEqual({ data: [] });
    expect(calls).toBe(2);
  });

  it("retries on transient network errors (ECONNRESET)", async () => {
    let calls = 0;
    const netErr = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const result = await withGitHubRetry(async () => {
      calls++;
      if (calls < 2) throw netErr;
      return "recovered";
    }, fast);

    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("retries on undici 'fetch failed' errors", async () => {
    let calls = 0;
    const fetchErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    });
    const result = await withGitHubRetry(async () => {
      calls++;
      if (calls < 2) throw fetchErr;
      return "ok";
    }, fast);

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("honors a numeric Retry-After header (with injected 0 sleep)", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withGitHubRetry(
      async () => {
        calls++;
        if (calls < 2) throw httpError(429, { "retry-after": "7" });
        return "ok";
      },
      {
        baseDelayMs: 100,
        random: () => 0,
        log: () => {},
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    // 7 seconds → 7000ms, used instead of the exponential backoff.
    expect(delays).toEqual([7000]);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    let thrown: unknown;
    try {
      await withGitHubRetry(async () => {
        calls++;
        throw httpError(500);
      }, { ...fast, maxAttempts: 4 });
    } catch (err) {
      thrown = err;
    }

    expect(calls).toBe(4);
    expect((thrown as { status?: number }).status).toBe(500);
  });

  it("does NOT retry on 404 (terminal)", async () => {
    let calls = 0;
    let thrown: unknown;
    try {
      await withGitHubRetry(async () => {
        calls++;
        throw httpError(404);
      }, fast);
    } catch (err) {
      thrown = err;
    }

    expect(calls).toBe(1);
    expect((thrown as { status?: number }).status).toBe(404);
  });

  it("does NOT retry on 422 (terminal validation error)", async () => {
    let calls = 0;
    let thrown: unknown;
    try {
      await withGitHubRetry(async () => {
        calls++;
        throw httpError(422);
      }, fast);
    } catch (err) {
      thrown = err;
    }

    expect(calls).toBe(1);
    expect((thrown as { status?: number }).status).toBe(422);
  });

  it("does NOT retry on 401/403 (terminal auth errors)", async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      try {
        await withGitHubRetry(async () => {
          calls++;
          throw httpError(status);
        }, fast);
      } catch {
        // expected
      }
      expect(calls).toBe(1);
    }
  });

  it("returns the value without sleeping when the first call succeeds", async () => {
    let slept = false;
    const result = await withGitHubRetry(async () => "fast", {
      ...fast,
      sleep: async () => {
        slept = true;
      },
    });
    expect(result).toBe("fast");
    expect(slept).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs(httpError(429, { "retry-after": "120" }))).toBe(120000);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    const future = "Wed, 21 Oct 2015 07:28:30 GMT";
    expect(parseRetryAfterMs(httpError(429, { "retry-after": future }), now)).toBe(30000);
  });

  it("clamps a past HTTP-date to 0", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:29:00 GMT");
    const past = "Wed, 21 Oct 2015 07:28:00 GMT";
    expect(parseRetryAfterMs(httpError(429, { "retry-after": past }), now)).toBe(0);
  });

  it("returns undefined when the header is absent", () => {
    expect(parseRetryAfterMs(httpError(429))).toBeUndefined();
  });
});
