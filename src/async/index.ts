import type { Logger } from "../logging/Logger.js";

interface RetryOptions {
  /** Maximum number of attempts before giving up (including the first try) */
  maxAttempts: number;
  /** Base delay in ms before the first retry; doubles each subsequent attempt */
  baseDelayMs: number;
  /** Upper bound on the computed delay to avoid unreasonably long waits */
  maxDelayMs: number;
  /** If provided, logs a warning on each retry with attempt info */
  logger?: Logger;
  /** Return false to short-circuit retries and throw immediately */
  shouldRetry?: (error: unknown) => boolean;
}

const defaults: Required<Omit<RetryOptions, "logger" | "shouldRetry">> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

/**
 * Retry an async function with exponential backoff and jitter.
 *
 * Delay formula: min(baseDelayMs * 2^(attempt-1), maxDelayMs) + random jitter.
 * Jitter is uniformly distributed in [0, baseDelayMs * 0.5) to decorrelate
 * concurrent callers without adding excessive wait time.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: Partial<RetryOptions>,
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, logger, shouldRetry } = {
    ...defaults,
    ...opts,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Allow the caller to abort retries for non-transient errors
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      if (attempt === maxAttempts) break;

      const exponentialDelay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.random() * baseDelayMs * 0.5;
      const delay = exponentialDelay + jitter;

      logger?.warn(
        `Attempt ${attempt}/${maxAttempts} failed, retrying in ${Math.round(delay)}ms`,
        error,
      );

      await sleep(delay);
    }
  }

  // All attempts exhausted
  throw lastError;
}

export type Result<T, E = Error> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: E; value?: never };

/** Wraps an async function call, returning a Result instead of throwing. */
export async function tryCatch<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { ok: false, error };
  }
}

/** Wraps a synchronous function call, returning a Result instead of throwing. */
export function tryCatchSync<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { ok: false, error };
  }
}

/** Returns a promise that resolves after the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Races a promise against a timeout, rejecting with TimeoutError if the deadline is exceeded. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
