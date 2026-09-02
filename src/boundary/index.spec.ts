import { assert, describe, it } from "@effect/vitest";
import { Clock, Data, Effect, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { forkReported, makeBoundary, runQuery } from "./index.js";

class BoomError extends Data.TaggedError("BoomError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `boom: ${this.detail}`;
  }
}

/** Settle a boundary Promise into a value, so a rejection is not a defect. */
const settle = <A>(promise: Promise<A>): Effect.Effect<"resolved" | "rejected"> =>
  Effect.promise(() =>
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
  );

/**
 * Pins the contract every `queryFn` relies on: a TanStack observer that aborts
 * its query's `AbortSignal` (a superseded key, an unmounted observer) must
 * actually interrupt the fiber `runQuery` started, not just abandon the Promise
 * and let the work run to completion.
 */
describe("runQuery", () => {
  it.live("aborting the signal interrupts the underlying effect", () => {
    // The controller is built outside the effect on purpose: it stands in for
    // the one TanStack owns, which is not Effect-managed.
    const controller = new AbortController();
    return Effect.gen(function* () {
      let interrupted = false;
      const promise = runQuery(
        Effect.sleep("10 seconds").pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
        controller.signal,
      );

      // Let the fiber actually start running before pulling the signal.
      yield* Effect.sleep("10 millis");
      controller.abort();

      assert.strictEqual(yield* settle(promise), "rejected");
      assert.strictEqual(interrupted, true);
    });
  });

  it.live("a signal that is never aborted lets the effect complete", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runQuery(Effect.succeed(42), new AbortController().signal),
      );
      assert.strictEqual(result, 42);
    }),
  );

  it.live("an absent signal still runs the effect", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runQuery(Effect.succeed("ok"), undefined),
      );
      assert.strictEqual(result, "ok");
    }),
  );
});

describe("forkReported", () => {
  it.live("reports a typed failure instead of throwing", () =>
    Effect.gen(function* () {
      const reported = yield* Effect.callback<BoomError>((resume) => {
        forkReported(new BoomError({ detail: "nope" }), (error) =>
          resume(Effect.succeed(error)),
        );
      });
      assert.strictEqual(reported._tag, "BoomError");
      assert.strictEqual(reported.message, "boom: nope");
    }),
  );

  it.live("runs a successful effect and reports nothing", () =>
    Effect.gen(function* () {
      let reports = 0;
      const done = yield* Effect.callback<string>((resume) => {
        forkReported(
          Effect.sync(() => resume(Effect.succeed("ran"))),
          () => {
            reports += 1;
          },
        );
      });
      assert.strictEqual(done, "ran");
      assert.strictEqual(reports, 0);
    }),
  );
});

describe("makeBoundary", () => {
  it.live("runs effects against the supplied runner's services", () =>
    Effect.gen(function* () {
      const runtime = ManagedRuntime.make(TestClock.layer());
      const boundary = makeBoundary(runtime);
      // The TestClock starts at 0, so this proves the runner's layer, not the
      // global runtime's wall clock, backed the run.
      const now = yield* Effect.promise(() =>
        boundary.runQuery(Clock.currentTimeMillis, undefined),
      ).pipe(Effect.ensuring(runtime.disposeEffect));
      assert.strictEqual(now, 0);
    }),
  );

  it.live("reports failures through the supplied runner", () =>
    Effect.gen(function* () {
      const runtime = ManagedRuntime.make(TestClock.layer());
      const boundary = makeBoundary(runtime);
      const reported = yield* Effect.callback<BoomError>((resume) => {
        boundary.forkReported(new BoomError({ detail: "runner" }), (error) =>
          resume(Effect.succeed(error)),
        );
      }).pipe(Effect.ensuring(runtime.disposeEffect));
      assert.strictEqual(reported.detail, "runner");
    }),
  );
});
