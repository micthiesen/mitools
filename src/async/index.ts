import { Duration, Effect, Schedule } from "effect";

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
 * Exponential backoff with jitter, capped at `maxDelayMs`, for at most
 * `maxAttempts` attempts. Delay before retry n (1-based):
 * `min(baseDelayMs * 2^(n-1), maxDelayMs)`, jittered. Every retry logs a
 * warning with the attempt number and the failure.
 */
export function retrySchedule<E = unknown>(
  options: RetryOptions<E> = {},
): Schedule.Schedule<Duration.Duration, E> {
  const { maxAttempts, baseDelayMs, maxDelayMs, shouldRetry } = {
    ...defaults,
    ...options,
  };
  return Schedule.max([
    Schedule.min([Schedule.exponential(baseDelayMs), Schedule.spaced(maxDelayMs)]).pipe(
      Schedule.jittered,
    ),
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
