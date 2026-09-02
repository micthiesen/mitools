import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  Data,
  Effect,
  Fiber,
  Layer,
  Random,
  Ref,
  Result,
  Schedule,
} from "effect";
import { TestClock } from "effect/testing";
import { Logger } from "../logging/index.js";
import { LogLevel } from "../logging/types.js";
import { exponentialBackoff, lockContention, spacedUpTo, withRetry } from "./index.js";

/** Routes `Effect.log*` into a capturing mitools `Logger`. */
const LogCapture = Logger.layerAdapter.pipe(Layer.provideMerge(Logger.layerCapture()));

/** A `Random` whose doubles are 0.5, so jitter lands exactly on the base delay. */
const withFixedRandom = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Random.Random, {
    nextIntUnsafe: () => 0,
    nextDoubleUnsafe: () => 0.5,
  });

class FlakyError extends Data.TaggedError("FlakyError")<{
  readonly attempt: number;
}> {}

/** An effect that counts its invocations and fails until `succeedOn`. */
const flaky = (calls: Ref.Ref<number>, succeedOn: number) =>
  Effect.gen(function* () {
    const attempt = yield* Ref.updateAndGet(calls, (n) => n + 1);
    if (attempt < succeedOn) return yield* new FlakyError({ attempt });
    return "ok" as const;
  });

describe("withRetry", () => {
  it.effect("returns the result on the first success", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const result = yield* withRetry(flaky(calls, 1));
      assert.strictEqual(result, "ok");
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("retries and eventually succeeds", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const fiber = yield* Effect.forkChild(
        withRetry(flaky(calls, 3), {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 10_000,
        }),
      );
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(yield* Fiber.join(fiber), "ok");
      assert.strictEqual(yield* Ref.get(calls), 3);
    }),
  );

  it.effect("fails with the last error once the attempts are exhausted", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const fiber = yield* Effect.forkChild(
        withRetry(flaky(calls, 99), {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 10_000,
        }).pipe(Effect.result),
      );
      yield* TestClock.adjust("1 minute");
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "FlakyError");
        assert.strictEqual(result.failure.attempt, 3);
      }
      assert.strictEqual(yield* Ref.get(calls), 3);
    }),
  );

  it.effect("stops after one attempt when shouldRetry returns false", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const fiber = yield* Effect.forkChild(
        withRetry(flaky(calls, 99), {
          maxAttempts: 5,
          baseDelayMs: 1000,
          shouldRetry: () => false,
        }).pipe(Effect.result),
      );
      yield* TestClock.adjust("1 minute");
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("backs off exponentially between attempts", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const fiber = yield* Effect.forkChild(
        withRetry(flaky(calls, 99), {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
        }).pipe(Effect.result),
      );

      // Jitter scales each delay by 0.8x-1.2x, so assert with slack: the
      // second attempt cannot land before 800ms and must land by 2s.
      yield* TestClock.adjust("500 millis");
      assert.strictEqual(yield* Ref.get(calls), 1);
      yield* TestClock.adjust("1500 millis");
      assert.strictEqual(yield* Ref.get(calls), 2);
      // Third delay is ~2s, so attempt 3 cannot have happened yet at t=2s
      // and must have happened by t=5s.
      yield* TestClock.adjust("3 seconds");
      assert.strictEqual(yield* Ref.get(calls), 3);

      yield* Fiber.join(fiber);
    }),
  );

  it.effect("caps the delay at maxDelayMs", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const maxAttempts = 6;
      const fiber = yield* Effect.forkChild(
        withRetry(flaky(calls, 99), {
          maxAttempts,
          baseDelayMs: 1000,
          maxDelayMs: 1000,
        }).pipe(Effect.result),
      );
      // Uncapped, attempt 6 would need 1+2+4+8+16 = 31s.
      yield* TestClock.adjust(`${maxAttempts * 1500} millis`);
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      assert.strictEqual(yield* Ref.get(calls), maxAttempts);
    }),
  );

  it.effect("logs a warning for every retry", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const fiber = yield* Effect.forkChild(
        withRetry(flaky(calls, 3), { maxAttempts: 3, baseDelayMs: 1000 }),
      );
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(fiber);

      const warnings = (yield* Logger.captured).filter(
        (item) => item.level === LogLevel.WARN,
      );
      assert.strictEqual(warnings.length, 2);
      assert.include(warnings[0]?.message ?? "", "Attempt 1/3 failed");
      assert.include(warnings[0]?.formattedArgs ?? "", "FlakyError");
    }).pipe(Effect.provide(LogCapture)),
  );
});

describe("Schedule presets", () => {
  const delays = <O>(schedule: Schedule.Schedule<O, string>, attempts: number) =>
    Effect.gen(function* () {
      const times: number[] = [];
      let n = 0;
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          times.push(yield* Clock.currentTimeMillis);
          n += 1;
          if (n <= attempts) return yield* Effect.fail("again");
        }).pipe(Effect.retry(schedule), Effect.ignore),
      );
      // Drive the clock far enough for any of the presets under test.
      for (let i = 0; i < 40; i++) yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      return times.slice(1).map((t, i) => t - (times[i] ?? 0));
    });

  it.effect("exponentialBackoff doubles up to the cap and recurs forever", () =>
    Effect.gen(function* () {
      const gaps = yield* delays(
        exponentialBackoff({ baseDelayMs: 1000, maxDelayMs: 3000 }).pipe(
          Schedule.setInputType<string>(),
        ),
        5,
      ).pipe(withFixedRandom);
      assert.deepStrictEqual(gaps, [1000, 2000, 3000, 3000, 3000]);
    }),
  );

  it.effect("spacedUpTo stops once the deadline has elapsed", () =>
    Effect.gen(function* () {
      const gaps = yield* delays(
        spacedUpTo(1000, 2500).pipe(Schedule.setInputType<string>()),
        10,
      ).pipe(withFixedRandom);
      // Retries at 1s, 2s and 3s: the deadline is checked on the step after
      // each failure (2s elapsed < 2.5s), so the last retry lands past it.
      assert.deepStrictEqual(gaps, [1000, 1000, 1000]);
    }),
  );

  it.effect("lockContention polls every 150ms until the timeout", () =>
    Effect.gen(function* () {
      const gaps = yield* delays(
        lockContention(500).pipe(Schedule.setInputType<string>()),
        10,
      ).pipe(withFixedRandom);
      // 150, 300, 450 (elapsed still under 500) and one final retry at 600.
      assert.deepStrictEqual(gaps, [150, 150, 150, 150]);
    }),
  );
});
