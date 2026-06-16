/**
 * Dependency-free retry/backoff wrapper for GitHub API calls.
 *
 * Transient failures (HTTP 429, 5xx, and network errors like ECONNRESET /
 * ETIMEDOUT / "fetch failed") abort a run or silently drop review comments
 * when made raw. This wraps the actual Octokit/REST call with capped
 * exponential backoff + jitter so a single blip doesn't lose feedback.
 *
 * Terminal errors (4xx other than 429 — 401/403/404/422) are NOT retried:
 * they won't change on retry and retrying just amplifies API spam.
 *
 * Behaviour on success is identical to calling `fn` directly. Callers that
 * intentionally degrade gracefully (try/catch around the wrapper) keep that
 * behaviour — transient failures are simply retried before the error
 * propagates out to their catch.
 */

export interface GitHubRetryOptions {
  /** Total attempts including the first try. Default 5. */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default 500. */
  baseDelayMs?: number;
  /** Cap on any single backoff delay in ms. Default 8000. */
  maxDelayMs?: number;
  /** Injectable sleep — tests pass a no-op for instant runs. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1) — tests pass () => 0 for determinism. */
  random?: () => number;
  /** Optional label used in log lines. */
  label?: string;
  /** Optional logger; defaults to console.warn. */
  log?: (msg: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** HTTP status codes worth retrying: 429 (rate limit) + any 5xx. */
function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 429 || (status >= 500 && status <= 599);
}

/** Transient network errors that resolve on their own. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
]);

function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  // undici / fetch surfaces network failures as a TypeError "fetch failed".
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string" && /fetch failed|network|socket hang up/i.test(message)) {
    return true;
  }
  // undici wraps the real reason on .cause — recurse into it.
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) return isTransientNetworkError(cause);
  return false;
}

/** Pull an HTTP status off an Octokit/REST error in its various shapes. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const direct = (err as { status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const responseStatus = (err as { response?: { status?: unknown } }).response?.status;
  if (typeof responseStatus === "number") return responseStatus;
  return undefined;
}

function isRetryable(err: unknown): boolean {
  return isRetryableStatus(statusOf(err)) || isTransientNetworkError(err);
}

/** Read response headers off an Octokit error in its various shapes. */
function headersOf(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== "object") return undefined;
  const responseHeaders = (err as { response?: { headers?: unknown } }).response?.headers;
  if (responseHeaders && typeof responseHeaders === "object") {
    return responseHeaders as Record<string, unknown>;
  }
  const directHeaders = (err as { headers?: unknown }).headers;
  if (directHeaders && typeof directHeaders === "object") {
    return directHeaders as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Parse a Retry-After header into milliseconds. Supports both the
 * delta-seconds form ("120") and the HTTP-date form
 * ("Wed, 21 Oct 2015 07:28:00 GMT"). Returns undefined when absent/invalid.
 */
export function parseRetryAfterMs(err: unknown, now: number = Date.now()): number | undefined {
  const headers = headersOf(err);
  if (!headers) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (value === "") return undefined;

  // delta-seconds
  if (/^\d+$/.test(value)) {
    return parseInt(value, 10) * 1000;
  }

  // HTTP-date
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - now);
  }
  return undefined;
}

/**
 * Run `fn`, retrying transient GitHub failures with capped exponential
 * backoff + jitter. Honors a Retry-After header when present.
 */
export async function withGitHubRetry<T>(
  fn: () => Promise<T>,
  options: GitHubRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((msg: string) => console.warn(msg));
  const label = options.label ? `${options.label} ` : "";

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const lastAttempt = attempt >= maxAttempts;
      if (lastAttempt || !isRetryable(err)) {
        throw err;
      }

      // Prefer the server's own Retry-After hint; otherwise exponential
      // backoff with full jitter, capped at maxDelayMs.
      const retryAfterMs = parseRetryAfterMs(err);
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = backoff * random();
      const delayMs =
        retryAfterMs !== undefined
          ? Math.min(maxDelayMs, retryAfterMs)
          : jittered;

      const status = statusOf(err);
      const reason = status !== undefined ? `HTTP ${status}` : (err as Error)?.message || "network error";
      log(
        `${label}GitHub call failed (${reason}); retry ${attempt}/${maxAttempts - 1} in ${Math.round(delayMs)}ms`,
      );
      await sleep(delayMs);
    }
  }
}
