/**
 * Test helpers for consumers of this library. Importing
 * `@micthiesen/mitools/testing` pulls in `vitest` (an optional peer
 * dependency), so it belongs in test files only, never in production code.
 *
 * Together with `../boundary/index.ts` and `../react/index.ts` this is one of
 * the three sanctioned places the library runs an effect: a test runner is an
 * external contract that cannot yield.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Duration } from "effect";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterAll } from "vitest";
import type { EffectRunner } from "../boundary/index.js";
import { operationErrors } from "../errors/index.js";

const io = operationErrors("testing");

/**
 * Fork `effect`, advance the `TestClock` by `duration`, then join it: the
 * fork/adjust/join dance every test of a sleeping, retrying or scheduled effect
 * needs, because an effect that sleeps on the test clock blocks until the clock
 * moves and the clock cannot move from the fiber that is blocked.
 *
 * Use this inside `it.effect`, where `@effect/vitest` already provides the test
 * clock. A bare number of milliseconds is a valid `duration`, as is
 * `"10 seconds"`.
 */
export const withVirtualTime = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  duration: Duration.Input,
) {
  const fiber = yield* Effect.forkChild(effect);
  yield* TestClock.adjust(duration);
  return yield* Fiber.join(fiber);
});

/**
 * The Promise form of `withVirtualTime` for a plain (non-`it.effect`) test: it
 * supplies its own `TestClock` layer, so a ten second sleep costs no wall time.
 *
 * ```ts
 * const value = await runWithVirtualTime(retryingFetch, "1 minute");
 * ```
 *
 * Prefer `withVirtualTime` under `@effect/vitest`'s `it.effect`; this exists
 * for tests that are not written as effects.
 */
export function runWithVirtualTime<A, E>(
  effect: Effect.Effect<A, E, TestClock.TestClock>,
  duration: Duration.Input,
): Promise<A> {
  return Effect.runPromise(
    withVirtualTime(effect, duration).pipe(Effect.provide(TestClock.layer())),
  );
}

/** What `trackedTmpDirs` hands back: a factory for swept scratch directories. */
export interface TrackedTmpDirs {
  /** Create a fresh directory under the OS temp dir, removed after the suite. */
  readonly tmp: (prefix: string) => string;
}

/**
 * Register a tracked temp-directory factory plus one `afterAll` sweep for the
 * current test file. Call it once at file or `describe` scope (never inside a
 * test, where vitest refuses to register hooks); each `tmp(prefix)` call
 * `mkdtemp`s a fresh directory and queues it for removal once the suite ends.
 *
 * ```ts
 * const { tmp } = trackedTmpDirs();
 * it("writes a file", () => { const dir = tmp("my-suite-"); ... });
 * ```
 *
 * Synchronous on purpose: it is called from vitest's collection phase, not from
 * an effect. Use `tmpDir` when the directory should die with a `Scope` instead.
 */
export function trackedTmpDirs(): TrackedTmpDirs {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  return {
    tmp: (prefix: string): string => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
  };
}

/**
 * A scratch directory that lives exactly as long as the enclosing `Scope`: it
 * is created on acquire and removed recursively on release, including when the
 * test fiber is interrupted. The scoped counterpart of `trackedTmpDirs`, and
 * the one to use inside `it.effect`, which already provides a `Scope`.
 *
 * Fails with `OperationError` if the directory cannot be created.
 */
export const tmpDir = Effect.fn("tmpDir")(function* (prefix: string) {
  return yield* Effect.acquireRelease(
    io.sync("mkdtemp", () => mkdtempSync(join(tmpdir(), prefix))),
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true });
      }),
  );
});

/** An `EffectRunner` that provides `context` to everything it runs. */
function contextRunner<R>(context: Context.Context<R>): EffectRunner<R> {
  return {
    runPromise: (effect, options) =>
      Effect.runPromise(Effect.provide(effect, context), options),
    runFork: (effect, options) =>
      Effect.runFork(Effect.provide(effect, context), options),
  };
}

/**
 * Build `layer` once and expose it as an `EffectRunner`, so a production entry
 * point that takes a runner (see `makeBoundary` in
 * `@micthiesen/mitools/boundary`) can be driven under test layers such as
 * `TestClock`. The layer's resources are released when the enclosing `Scope`
 * closes, which under `it.effect` is the end of the test.
 *
 * ```ts
 * it.effect("retries through the boundary", () =>
 *   Effect.gen(function* () {
 *     const runner = yield* testRuntime(Layer.mergeAll(TestClock.layer(), Api.layerStub));
 *     const { runQuery } = makeBoundary(runner);
 *     startTheApp({ runQuery });
 *     yield* TestClock.adjust("1 minute");
 *   }),
 * );
 * ```
 *
 * The returned runner has no layer error of its own: a failing layer fails this
 * effect instead, at the point the runner is built.
 */
export const testRuntime = Effect.fnUntraced(function* <R, E>(
  layer: Layer.Layer<R, E>,
) {
  return contextRunner(yield* Layer.build(layer));
});
