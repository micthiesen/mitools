/**
 * The framework-free run boundary: the two places a UI consumer has to hand an
 * Effect to code that cannot yield. A TanStack `queryFn` must return a Promise
 * and an event callback (a keypress handler, an `onClick`) is a plain function,
 * so the fiber is started here and its outcome is translated into the contract
 * the caller already has.
 *
 * This module and `../react/index.ts` and `../testing/index.ts` are the only
 * places in the library that run an effect; everything else returns one.
 */
import { Effect, type Fiber } from "effect";

/**
 * Somewhere an effect can be run. Structurally a subset of Effect's
 * `ManagedRuntime`, so a `ManagedRuntime.make(layer)` whose layer cannot fail
 * (`ManagedRuntime<R, never>`) is a valid runner without any adapter. `R` is
 * the set of services the runner supplies, so effects run through it may
 * require them.
 */
export interface EffectRunner<R = never> {
  /** Run an effect to a Promise. `options.signal` interrupts the fiber. */
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions | undefined,
  ) => Promise<A>;
  /** Start an effect on its own fiber and return it. */
  readonly runFork: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions | undefined,
  ) => Fiber.Fiber<A, E>;
}

/**
 * The default runner: Effect's global runtime, with no services beyond the
 * built-in ones. `runQuery` and `forkReported` are bound to it.
 */
export const globalRunner: EffectRunner = {
  runPromise: Effect.runPromise,
  runFork: Effect.runFork,
};

/** The boundary functions bound to one runner. See `makeBoundary`. */
export interface Boundary<R = never> {
  /** See the module-level `runQuery`. */
  readonly runQuery: <A, E>(
    effect: Effect.Effect<A, E, R>,
    signal: AbortSignal | undefined,
  ) => Promise<A>;
  /** See the module-level `forkReported`. */
  readonly forkReported: <A, E>(
    effect: Effect.Effect<A, E, R>,
    report: (error: E) => void,
  ) => void;
}

/**
 * Bind `runQuery` and `forkReported` to a specific runner. A production entry
 * point builds its `ManagedRuntime` once and passes it here, and a test passes
 * a runner built from a test layer (see `testRuntime` in
 * `@micthiesen/mitools/testing`), so the same boundary code runs under
 * `TestClock` without a global.
 */
export function makeBoundary<R = never>(runner: EffectRunner<R>): Boundary<R> {
  return {
    runQuery: (effect, signal) =>
      runner.runPromise(effect, signal ? { signal } : undefined),
    forkReported: (effect, report) => {
      runner.runFork(
        effect.pipe(Effect.catch((error) => Effect.sync(() => report(error)))),
      );
    },
  };
}

const global = makeBoundary(globalRunner);

/**
 * Run a query effect at the TanStack boundary, wired to its `AbortSignal`. A
 * `queryFn` must return a Promise, so every source builds an Effect and hands
 * it here with the query context's `signal`: when TanStack cancels (a
 * superseded key, an unmounted observer) the signal aborts and the fiber is
 * interrupted, which reaches any subprocess or resource it acquired, instead of
 * letting a stale fetch run to completion.
 *
 * The returned Promise rejects on failure and on interruption, which is what
 * TanStack expects.
 */
export function runQuery<A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal | undefined,
): Promise<A> {
  return global.runQuery(effect, signal);
}

/**
 * Run an effect from an event callback: fork once, and report its typed
 * failure through `report` (a toast, a status line) instead of throwing into
 * React or dropping an unhandled rejection.
 *
 * Fire-and-forget on purpose. The action finishes even if the component that
 * started it unmounts; anything that must be cancelled with a component's
 * lifetime goes through `useEffectFiber` from `@micthiesen/mitools/react`.
 *
 * Only typed failures reach `report`. A defect (a thrown exception, a bug) is
 * deliberately left alone: it stays an unhandled fiber failure that Effect
 * logs, because swallowing it into a toast would hide a crash that should be
 * fixed rather than displayed.
 */
export function forkReported<A, E>(
  effect: Effect.Effect<A, E>,
  report: (error: E) => void,
): void {
  global.forkReported(effect, report);
}
