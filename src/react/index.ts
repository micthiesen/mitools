/**
 * The React run boundary: one fiber per mount, interrupted on cleanup.
 *
 * `react` is an optional peer dependency; importing
 * `@micthiesen/mitools/react` requires React 19. Only `react` itself is
 * imported, never `react-dom`, so this works in any renderer.
 */
import { type Effect, Fiber } from "effect";
import { type DependencyList, useEffect } from "react";
import { type EffectRunner, globalRunner } from "../boundary/index.js";

/** The start/cleanup pair `useEffectFiber` hands to React's `useEffect`. */
export interface FiberLifecycle {
  /**
   * Fork the effect and return the cleanup that interrupts it, or `undefined`
   * when `make` returned `null` and there is nothing to run.
   */
  readonly start: () => (() => void) | undefined;
}

/**
 * The whole of `useEffectFiber` minus React: call `make`, fork what it returns
 * on `runner`, and hand back a cleanup that interrupts the fiber. Exported so
 * the lifecycle can be tested without a renderer, and so a non-React caller
 * with the same mount/unmount shape can reuse it.
 *
 * The effect must not fail. Surface failures inside it (log, toast, see
 * `forkReported`) so nothing escapes as an unhandled defect.
 */
export function fiberLifecycle<R = never>(
  make: () => Effect.Effect<unknown, never, R> | null,
  runner: EffectRunner<R>,
): FiberLifecycle {
  return {
    start: () => {
      const effect = make();
      if (!effect) return undefined;
      const fiber = runner.runFork(effect);
      return () => {
        runner.runFork(Fiber.interrupt(fiber));
      };
    },
  };
}

/**
 * Own one fiber per mount: fork on mount and on every dependency change,
 * interrupt on cleanup. Return `null` from `make` to run nothing for this
 * render. Pass `runner` to run against a specific `ManagedRuntime` (its
 * services then become available to the effect); omitted, the global runtime
 * is used.
 *
 * A thin wrapper over `fiberLifecycle`, which holds the actual behaviour and
 * is what the tests exercise.
 */
export function useEffectFiber(
  make: () => Effect.Effect<unknown, never> | null,
  deps: DependencyList,
): void;
export function useEffectFiber<R>(
  make: () => Effect.Effect<unknown, never, R> | null,
  deps: DependencyList,
  runner: EffectRunner<R>,
): void;
export function useEffectFiber<R>(
  make: () => Effect.Effect<unknown, never, R> | null,
  deps: DependencyList,
  runner?: EffectRunner<R>,
): void {
  // Sound because the overloads only allow the runner to be omitted when the
  // effect needs no services, which is exactly what `globalRunner` supplies.
  const active = runner ?? (globalRunner as EffectRunner<R>);
  const { start } = fiberLifecycle(make, active);
  // The dependency list is the caller's contract, exactly as with `useEffect`
  // itself: `make` is re-invoked whenever `deps` change.
  useEffect(start, deps);
}
