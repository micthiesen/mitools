import { assert, describe, it } from "@effect/vitest";
import { Data, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Logger } from "./Logger.js";
import { LogLevel } from "./types.js";

const TestLayer = Logger.layerTracer.pipe(
  Layer.provideMerge(Logger.layerCapture({ level: LogLevel.DEBUG })),
);

class BoomError extends Data.TaggedError("BoomError") {
  override get message(): string {
    return "boom";
  }
}

const inner = Effect.fn("Test.inner")(function* () {
  yield* Effect.sleep("250 millis");
});

const outer = Effect.fn("Test.outer")(function* () {
  yield* Effect.sleep("1 second");
  yield* inner();
});

describe("Logger.layerTracer", () => {
  it.effect(
    "logs every ended span at debug with its duration, parent and outcome",
    () =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(outer());
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(fiber);
        const spans = (yield* Logger.captured).filter(
          (item) => item.loggerName === "Tracer",
        );
        assert.deepStrictEqual(
          spans.map((item) => [item.level, item.message]),
          [
            [LogLevel.DEBUG, "Test.inner 250ms"],
            [LogLevel.DEBUG, "Test.outer 1250ms"],
          ],
        );
        assert.deepStrictEqual(spans[0]?.args[0], {
          outcome: "ok",
          parent: "Test.outer",
        });
        assert.deepStrictEqual(spans[1]?.args[0], { outcome: "ok" });
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records a failure's message and span attributes", () =>
    Effect.gen(function* () {
      const failing = Effect.fn("Test.failing")(function* () {
        yield* Effect.annotateCurrentSpan("retries", 2);
        return yield* new BoomError();
      });
      yield* failing().pipe(Effect.ignore);
      const spans = (yield* Logger.captured).filter(
        (item) => item.loggerName === "Tracer",
      );
      assert.strictEqual(spans.length, 1);
      assert.strictEqual(spans[0]?.message, "Test.failing 0.0ms");
      assert.deepStrictEqual(spans[0]?.args[0], {
        outcome: "failed: boom",
        attributes: { retries: 2 },
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});
