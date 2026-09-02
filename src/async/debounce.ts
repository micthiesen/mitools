import { Effect, Fiber, FiberSet, Ref, type Scope, Semaphore } from "effect";

/**
 * A trailing-edge debouncer over a plain callback. Every `trigger` restarts the
 * wait; the callback runs once the last trigger has been quiet for the
 * configured window.
 */
export interface Debounced {
  /** Restarts the wait. A no-op after `cancel`. */
  readonly trigger: Effect.Effect<void>;
  /**
   * `trigger` for synchronous callers such as an `fs.watch` listener. Runs in a
   * fiber owned by the debouncer's scope; nothing is returned to await.
   */
  triggerUnsafe(): void;
  /**
   * Drops the pending callback and disposes the debouncer: later triggers do
   * nothing. Idempotent.
   */
  readonly cancel: Effect.Effect<void>;
  /** `cancel` for synchronous callers. */
  cancelUnsafe(): void;
}

/**
 * Creates a trailing-edge debouncer that calls `onChange` once `ms`
 * milliseconds have passed without a trigger. Bursty sources (an editor save
 * storm seen through `fs.watch`, a `git fetch` writing many refs) collapse into
 * one call.
 *
 * The pending callback lives in a fiber forked into the calling scope, so
 * closing that scope drops it; the scope's finalizer also cancels the
 * debouncer. Sleeping uses the Effect `Clock`, so `TestClock` drives it in
 * tests.
 */
export const makeDebounced = Effect.fn("makeDebounced")(function* (
  onChange: () => void,
  ms: number,
): Effect.fn.Return<Debounced, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  // The sync adapters run through this scope-owned runtime rather than a global
  // `Effect.runFork`, so their fibers die with the scope.
  const runUnsafe = yield* FiberSet.makeRuntime<never, void, never>();
  // Two triggers landing at once must not each fork a pending fiber.
  const gate = yield* Semaphore.make(1);
  const disposed = yield* Ref.make(false);
  const pending = yield* Ref.make<Fiber.Fiber<void> | null>(null);

  const interruptPending = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(pending, null);
    if (fiber !== null) yield* Fiber.interrupt(fiber);
  });

  const fire = Effect.sleep(ms).pipe(
    Effect.andThen(Ref.get(disposed)),
    Effect.flatMap((isDisposed) =>
      isDisposed ? Effect.void : Effect.sync(() => onChange()),
    ),
  );

  const trigger = Semaphore.withPermits(
    gate,
    1,
  )(
    Effect.gen(function* () {
      if (yield* Ref.get(disposed)) return;
      yield* interruptPending;
      yield* Ref.set(pending, yield* Effect.forkIn(fire, scope));
    }),
  );

  const cancel = Semaphore.withPermits(
    gate,
    1,
  )(Effect.andThen(Ref.set(disposed, true), interruptPending));

  yield* Effect.addFinalizer(() => cancel);

  return {
    trigger,
    triggerUnsafe: () => {
      runUnsafe(trigger);
    },
    cancel,
    cancelUnsafe: () => {
      runUnsafe(cancel);
    },
  };
});
