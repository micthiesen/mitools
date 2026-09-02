import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Random, Ref, Result } from "effect";
import { TestClock } from "effect/testing";
import { Logger } from "../logging/index.js";
import { LogLevel } from "../logging/types.js";
import type { ScheduledTask } from "./ScheduledTask.js";
import { InvalidScheduleError, Scheduler } from "./Scheduler.js";

/** Every ten seconds, on the second. */
const EVERY_10S = "*/10 * * * * *";

const LogCapture = Logger.layerAdapter.pipe(Layer.provideMerge(Logger.layerCapture()));

const TestLayer = Layer.mergeAll(Scheduler.layer, LogCapture);

/** A deterministic `Random` so `jitterMs` picks the midpoint of its range. */
const withFixedRandom = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Random.Random, {
    nextIntUnsafe: () => 0,
    nextDoubleUnsafe: () => 0.5,
  });

const counterTask = (
  counter: Ref.Ref<number>,
  overrides: Partial<ScheduledTask> = {},
): ScheduledTask => ({
  name: "counter",
  schedule: EVERY_10S,
  run: Ref.update(counter, (n) => n + 1),
  ...overrides,
});

describe("Scheduler", () => {
  it.effect("runs a task on every cron match", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const counter = yield* Ref.make(0);
      yield* scheduler.register(counterTask(counter));
      yield* scheduler.start;

      yield* TestClock.adjust("35 seconds");
      // Fires at 10s, 20s and 30s; never at 0s (the cron match is strict).
      assert.strictEqual(yield* Ref.get(counter), 3);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("runs immediately when runOnStartup is set", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const counter = yield* Ref.make(0);
      yield* scheduler.register(counterTask(counter, { runOnStartup: true }));
      yield* scheduler.start;

      yield* TestClock.adjust("1 milli");
      assert.strictEqual(yield* Ref.get(counter), 1);
      yield* TestClock.adjust("35 seconds");
      assert.strictEqual(yield* Ref.get(counter), 4);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("delays a run by up to jitterMs", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const counter = yield* Ref.make(0);
      yield* scheduler.register(counterTask(counter, { jitterMs: 5000 }));
      yield* scheduler.start;

      // The fixed Random puts the jitter at 2500ms after the 10s cron match.
      yield* TestClock.adjust("12 seconds");
      assert.strictEqual(yield* Ref.get(counter), 0);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Ref.get(counter), 1);
    }).pipe(withFixedRandom, Effect.provide(TestLayer)),
  );

  it.effect("never runs one task concurrently with itself", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const started = yield* Ref.make(0);
      const finished = yield* Ref.make(0);
      const concurrent = yield* Ref.make(0);
      const maxConcurrent = yield* Ref.make(0);

      yield* scheduler.register({
        name: "slow",
        schedule: EVERY_10S,
        run: Effect.gen(function* () {
          yield* Ref.update(started, (n) => n + 1);
          const inFlight = yield* Ref.updateAndGet(concurrent, (n) => n + 1);
          yield* Ref.update(maxConcurrent, (n) => Math.max(n, inFlight));
          yield* Effect.sleep("25 seconds");
          yield* Ref.update(concurrent, (n) => n - 1);
          yield* Ref.update(finished, (n) => n + 1);
        }),
      });
      yield* scheduler.start;

      // Runs occupy 10s-35s and 40s-65s; the cron would have fired six times.
      yield* TestClock.adjust("67 seconds");
      assert.strictEqual(yield* Ref.get(maxConcurrent), 1);
      assert.strictEqual(yield* Ref.get(started), 2);
      assert.strictEqual(yield* Ref.get(finished), 2);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("logs a failing run and keeps the schedule going", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const counter = yield* Ref.make(0);
      yield* scheduler.register({
        name: "failing",
        schedule: EVERY_10S,
        run: Ref.update(counter, (n) => n + 1).pipe(
          Effect.andThen(Effect.fail("x" as const)),
        ),
      });
      yield* scheduler.start;

      yield* TestClock.adjust("35 seconds");
      assert.strictEqual(yield* Ref.get(counter), 3);

      const errors = (yield* Logger.captured).filter(
        (item) => item.level === LogLevel.ERROR,
      );
      assert.strictEqual(errors.length, 3);
      assert.strictEqual(errors[0]?.loggerName, "Scheduler");
      assert.include(errors[0]?.message ?? "", 'Error running task "failing"');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("logs a defect and keeps the schedule going", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const counter = yield* Ref.make(0);
      yield* scheduler.register({
        name: "dying",
        schedule: EVERY_10S,
        run: Ref.update(counter, (n) => n + 1).pipe(
          Effect.andThen(Effect.die(new Error("boom"))),
        ),
      });
      yield* scheduler.start;

      yield* TestClock.adjust("25 seconds");
      assert.strictEqual(yield* Ref.get(counter), 2);

      const errors = (yield* Logger.captured).filter(
        (item) => item.level === LogLevel.ERROR,
      );
      assert.strictEqual(errors.length, 2);
      assert.include(errors[0]?.formattedArgs ?? "", "boom");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a task whose cron expression does not parse", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const result = yield* scheduler
        .register({ name: "bad", schedule: "not a cron", run: Effect.void })
        .pipe(Effect.result);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "InvalidScheduleError");
        assert.instanceOf(result.failure, InvalidScheduleError);
        assert.strictEqual(result.failure.task, "bad");
        assert.include(result.failure.message, "not a cron");
      }
      assert.deepStrictEqual(yield* scheduler.tasks, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a task whose cron expression parses but never matches", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const error = yield* scheduler
        .register({ name: "never", schedule: "0 0 0 30 2 *", run: Effect.void })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "InvalidScheduleError");
      assert.strictEqual(error.task, "never");
      assert.deepStrictEqual(yield* scheduler.tasks, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("lists the registered tasks", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const counter = yield* Ref.make(0);
      yield* scheduler.register(counterTask(counter, { name: "first" }));
      yield* scheduler.register(
        counterTask(counter, { name: "second", schedule: "0 * * * * *" }),
      );

      assert.deepStrictEqual(yield* scheduler.tasks, [
        { name: "first", schedule: EVERY_10S },
        { name: "second", schedule: "0 * * * * *" },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("captures the task's requirements at registration", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const seen = yield* Ref.make<string[]>([]);
      yield* scheduler
        .register({
          name: "needs-greeter",
          schedule: EVERY_10S,
          run: Greeter.use((greeter) =>
            Ref.update(seen, (all) => [...all, greeter.greeting]),
          ),
        })
        .pipe(Effect.provideService(Greeter, Greeter.of({ greeting: "hello" })));
      yield* scheduler.start;

      yield* TestClock.adjust("25 seconds");
      assert.deepStrictEqual(yield* Ref.get(seen), ["hello", "hello"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("shutdown waits for a run in flight and then stops firing", () =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const finished = yield* Ref.make(0);
      yield* scheduler.register({
        name: "slow-startup",
        schedule: EVERY_10S,
        runOnStartup: true,
        run: Effect.sleep("5 seconds").pipe(
          Effect.andThen(Ref.update(finished, (n) => n + 1)),
        ),
      });
      yield* scheduler.start;

      yield* TestClock.adjust("1 milli");
      const shutdown = yield* Effect.forkChild(scheduler.shutdown);
      assert.strictEqual(yield* Ref.get(finished), 0);

      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(shutdown);
      assert.strictEqual(yield* Ref.get(finished), 1);

      yield* TestClock.adjust("60 seconds");
      assert.strictEqual(yield* Ref.get(finished), 1);

      // Idempotent.
      yield* scheduler.shutdown;
    }).pipe(Effect.provide(TestLayer)),
  );
});

class Greeter extends Context.Service<Greeter, { readonly greeting: string }>()(
  "test/Greeter",
) {}
