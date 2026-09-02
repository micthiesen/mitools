import { Duration, Effect, Schedule } from "effect";

export { type Debounced, makeDebounced } from "./debounce.js";

export interface RetryOptions<E = unknown> {
  /** Maximum number of attempts before giving up (including the first try). Default 3. */
  readonly maxAttempts?: number;
  /** Base delay in ms before the first retry; doubles each subsequent attempt. Default 1000. */
  readonly baseDelayMs?: number;
  /** Upper bound on the computed delay. Default 30_000. */
  readonly maxDelayMs?: number;
  /** Return false to stop retrying and fail with that error immediately. */
  readonly shouldRetry?: (error: E) => boolean;
}

const defaults = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000 };

/**
 * Jittered exponential backoff capped at `maxDelayMs`: the delay before
 * retry n (1-based) is `min(baseDelayMs * 2^(n-1), maxDelayMs)`, jittered.
 * Recurs forever; bound it with `Schedule.upTo` or `Schedule.recurs`.
 */
export function exponentialBackoff(options: {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}): Schedule.Schedule<Duration.Duration> {
  return Schedule.min([
    Schedule.exponential(options.baseDelayMs),
    Schedule.spaced(options.maxDelayMs),
  ]).pipe(Schedule.jittered);
}

/**
 * Jittered fixed spacing that stops once `deadlineMs` has elapsed. The
 * shape behind every "poll until the deadline" loop:
 * `Effect.repeat(check, { schedule: spacedUpTo(100, 5000), until: (ok) => ok })`
 * or `Effect.retry(attempt, spacedUpTo(150, 120_000))`.
 */
export function spacedUpTo(
  intervalMs: number,
  deadlineMs: number,
): Schedule.Schedule<number> {
  return Schedule.spaced(Duration.millis(intervalMs)).pipe(
    Schedule.jittered,
    Schedule.upTo({ duration: Duration.millis(deadlineMs) }),
  );
}

/**
 * The lock-contention schedule: poll every `pollMs` (default 150 ms,
 * jittered so competing processes never retry in lockstep) for at most
 * `timeoutMs`.
 */
export function lockContention(
  timeoutMs: number,
  pollMs = 150,
): Schedule.Schedule<number> {
  return spacedUpTo(pollMs, timeoutMs);
}

/**
 * `exponentialBackoff` for at most `maxAttempts` attempts, with a warning
 * logged before every retry naming the attempt and the failure. Stops early
 * when `shouldRetry` returns false.
 */
export function retrySchedule<E = unknown>(
  options: RetryOptions<E> = {},
): Schedule.Schedule<Duration.Duration, E> {
  const { maxAttempts, baseDelayMs, maxDelayMs, shouldRetry } = {
    ...defaults,
    ...options,
  };
  return Schedule.max([
    exponentialBackoff({ baseDelayMs, maxDelayMs }),
    Schedule.recurs(maxAttempts - 1),
  ]).pipe(
    Schedule.setInputType<E>(),
    Schedule.while(({ input }) => (shouldRetry ? shouldRetry(input) : true)),
    Schedule.tap(({ attempt, duration, input }) =>
      Effect.logWarning(
        `Attempt ${attempt}/${maxAttempts} failed, retrying in ${Math.round(Duration.toMillis(duration))}ms`,
        input,
      ),
    ),
  );
}

/** `Effect.retry` with `retrySchedule(options)`. */
export function withRetry<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: RetryOptions<E>,
): Effect.Effect<A, E, R> {
  return Effect.retry(effect, retrySchedule<E>(options));
}
