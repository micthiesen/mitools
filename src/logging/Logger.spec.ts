import { assert, describe, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { Logger } from "./Logger.js";
import { type LogItem, LogLevel, type LogNotification } from "./types.js";

const tapInto = (sink: Ref.Ref<ReadonlyArray<LogItem>>) => (item: LogItem) =>
  Ref.update(sink, (items) => [...items, item]);

const notifyInto =
  (sink: Ref.Ref<ReadonlyArray<LogNotification>>) => (notification: LogNotification) =>
    Ref.update(sink, (items) => [...items, notification]);

const withAdapter = <A, E>(layer: Layer.Layer<A, E>) =>
  Logger.layerAdapter.pipe(Layer.provideMerge(layer));

describe("NamedLogger", () => {
  it.effect("gives the tap sub-threshold lines the sink never records", () => {
    const tapped = Ref.makeUnsafe<ReadonlyArray<LogItem>>([]);
    return Effect.gen(function* () {
      yield* Logger.named("Test").debug("hidden line");

      const items = yield* Ref.get(tapped);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0]!.level, LogLevel.DEBUG);
      assert.strictEqual(items[0]!.message, "hidden line");
      assert.strictEqual(items[0]!.loggerName, "Test");
      assert.isNumber(items[0]!.timestamp);

      assert.deepStrictEqual(yield* Logger.captured, []);
    }).pipe(
      Effect.provide(
        Logger.layerCapture({ level: LogLevel.INFO, onLog: tapInto(tapped) }),
      ),
    );
  });

  it.effect("builds hierarchical names with extend", () =>
    Effect.gen(function* () {
      const main = Logger.named("Main");
      const child = main.extend("LiveCheck");
      assert.strictEqual(child.name, "Main:LiveCheck");
      assert.strictEqual(main.extend(null).name, "Main");
      assert.strictEqual(child.extend("Inner").name, "Main:LiveCheck:Inner");

      yield* child.info("checking");

      const items = yield* Logger.captured;
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0]!.loggerName, "Main:LiveCheck");
    }).pipe(Effect.provide(Logger.layerCapture())),
  );

  it.effect("omits formattedArgs with no args and joins them otherwise", () =>
    Effect.gen(function* () {
      const logger = Logger.named("Test");
      yield* logger.info("no args");
      yield* logger.info("with args", "plain", { a: 1 }, 42);

      const items = yield* Logger.captured;
      assert.isUndefined(items[0]!.formattedArgs);
      assert.deepStrictEqual(items[0]!.args, []);
      assert.strictEqual(items[1]!.formattedArgs, 'plain {"a":1} 42');
      assert.deepStrictEqual(items[1]!.args, ["plain", { a: 1 }, 42]);
    }).pipe(Effect.provide(Logger.layerCapture())),
  );

  it.effect("stringifies Errors in formattedArgs", () =>
    Effect.gen(function* () {
      const error = new Error("bad");
      yield* Logger.named("Test").error("failed", error);

      const items = yield* Logger.captured;
      assert.include(items[0]!.formattedArgs!, "Error: bad");
    }).pipe(Effect.provide(Logger.layerCapture())),
  );

  it.effect("records the Clock timestamp on each item", () =>
    Effect.gen(function* () {
      yield* Logger.named("Test").info("first");
      yield* TestClock.adjust("5 seconds");
      yield* Logger.named("Test").info("second");

      const items = yield* Logger.captured;
      assert.strictEqual(items[0]!.timestamp, 0);
      assert.strictEqual(items[1]!.timestamp, 5000);
    }).pipe(Effect.provide(Logger.layerCapture())),
  );

  it.effect("exposes the configured level on the service", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Logger).level, LogLevel.WARN);
    }).pipe(Effect.provide(Logger.layer({ level: LogLevel.WARN }))),
  );
});

describe("Logger.layer console output", () => {
  it.effect("writes a formatted line and suppresses sub-threshold levels", () => {
    const tapped = Ref.makeUnsafe<ReadonlyArray<LogItem>>([]);
    return Effect.gen(function* () {
      const logger = Logger.named("Test");
      yield* logger.warn("hidden");
      yield* logger.error("shown", { a: 1 });

      const errors = yield* TestConsole.errorLines;
      assert.deepStrictEqual(errors, ["00:00:00.000 [ERROR] <Test> shown", { a: 1 }]);

      const items = yield* Ref.get(tapped);
      assert.deepStrictEqual(
        items.map((item) => item.level),
        [LogLevel.WARN, LogLevel.ERROR],
      );
    }).pipe(
      Effect.provide(Logger.layer({ level: LogLevel.ERROR, onLog: tapInto(tapped) })),
    );
  });

  it.effect("still writes the console line when the tap dies", () =>
    Effect.gen(function* () {
      yield* Logger.named("Test").error("still logs");

      const errors = yield* TestConsole.errorLines;
      assert.strictEqual(errors[0], "Logger onLog hook failed:");
      assert.include(String(errors[1]), "boom");
      assert.strictEqual(errors[2], "00:00:00.000 [ERROR] <Test> still logs");
    }).pipe(
      Effect.provide(
        Logger.layer({ level: LogLevel.DEBUG, onLog: () => Effect.die("boom") }),
      ),
    ),
  );
});

const layerConfigWith = (env: Record<string, string>) =>
  Logger.layerConfig().pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

describe("Logger.layerConfig", () => {
  it.effect("reads the threshold from LOG_LEVEL", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Logger).level, LogLevel.WARN);
    }).pipe(Effect.provide(layerConfigWith({ LOG_LEVEL: "warn" }))),
  );

  it.effect("defaults to info when LOG_LEVEL is absent", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Logger).level, LogLevel.INFO);
    }).pipe(Effect.provide(layerConfigWith({}))),
  );
});

describe("Logger hooks", () => {
  it.effect("runs onError for error logs and Logger.flush waits for it", () => {
    const done = Ref.makeUnsafe(false);
    const flushed = Ref.makeUnsafe(false);
    const notifications = Ref.makeUnsafe<ReadonlyArray<LogNotification>>([]);
    return Effect.gen(function* () {
      yield* Logger.named("Main:Api").error("request failed", { status: 500 });
      assert.isFalse(yield* Ref.get(done));

      const fiber = yield* Effect.forkChild(
        Logger.flush.pipe(Effect.andThen(Ref.set(flushed, true))),
      );

      // Half way through the hook's sleep: flush is still blocked on it.
      yield* TestClock.adjust("500 millis");
      assert.isFalse(yield* Ref.get(done));
      assert.isFalse(yield* Ref.get(flushed));

      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(fiber);

      assert.isTrue(yield* Ref.get(done));
      assert.isTrue(yield* Ref.get(flushed));
      assert.deepStrictEqual(yield* Ref.get(notifications), [
        {
          level: LogLevel.ERROR,
          loggerName: "Main:Api",
          title: "request failed",
          body: '{"status":500}',
        },
      ]);
    }).pipe(
      Effect.provide(
        Logger.layerCapture({
          onError: (notification) =>
            notifyInto(notifications)(notification).pipe(
              Effect.andThen(Effect.sleep("1 second")),
              Effect.andThen(Ref.set(done, true)),
            ),
        }),
      ),
    );
  });

  it.effect("runs onWarn only for warn logs and falls back to the message body", () => {
    const notifications = Ref.makeUnsafe<ReadonlyArray<LogNotification>>([]);
    return Effect.gen(function* () {
      const logger = Logger.named("Test");
      yield* logger.info("ignored");
      yield* logger.error("also ignored");
      yield* logger.warn("careful");
      yield* Logger.flush;

      assert.deepStrictEqual(yield* Ref.get(notifications), [
        {
          level: LogLevel.WARN,
          loggerName: "Test",
          title: "careful",
          body: "careful",
        },
      ]);
    }).pipe(Effect.provide(Logger.layerCapture({ onWarn: notifyInto(notifications) })));
  });

  it.effect("reports a dying hook and keeps logging afterwards", () =>
    Effect.gen(function* () {
      const logger = Logger.named("Test");
      yield* logger.error("first");
      yield* Logger.flush;

      const errors = yield* TestConsole.errorLines;
      assert.strictEqual(errors[0], "Logger onError hook failed:");
      assert.include(String(errors[1]), "boom");

      yield* logger.info("second");
      const items = yield* Logger.captured;
      assert.deepStrictEqual(
        items.map((item) => item.message),
        ["first", "second"],
      );
    }).pipe(Effect.provide(Logger.layerCapture({ onError: () => Effect.die("boom") }))),
  );

  it.effect("clears captured items", () =>
    Effect.gen(function* () {
      yield* Logger.named("Test").info("one");
      yield* Logger.clearCaptured;
      assert.deepStrictEqual(yield* Logger.captured, []);

      yield* Logger.named("Test").info("two");
      const items = yield* Logger.captured;
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0]!.message, "two");
    }).pipe(Effect.provide(Logger.layerCapture())),
  );
});

describe("Logger.layerAdapter", () => {
  it.effect("routes Effect.log* through the sink using the logger annotation", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("hello", { a: 1 }).pipe(
        Effect.annotateLogs({ logger: "Docstore" }),
      );

      const items = yield* Logger.captured;
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0]!.level, LogLevel.INFO);
      assert.strictEqual(items[0]!.loggerName, "Docstore");
      assert.strictEqual(items[0]!.message, "hello");
      assert.deepStrictEqual(items[0]!.args, [{ a: 1 }]);
    }).pipe(Effect.provide(withAdapter(Logger.layerCapture()))),
  );

  it.effect("falls back to the 'effect' logger name and keeps other annotations", () =>
    Effect.gen(function* () {
      yield* Effect.logWarning("plain");
      yield* Effect.logInfo("annotated").pipe(Effect.annotateLogs({ span: "s1" }));

      const items = yield* Logger.captured;
      assert.strictEqual(items[0]!.loggerName, "effect");
      assert.deepStrictEqual(items[0]!.args, []);
      assert.strictEqual(items[1]!.loggerName, "effect");
      assert.deepStrictEqual(items[1]!.args, [{ span: "s1" }]);
    }).pipe(Effect.provide(withAdapter(Logger.layerCapture()))),
  );

  it.effect("lifts Effect's minimum level so the tap sees sub-threshold logs", () => {
    const tapped = Ref.makeUnsafe<ReadonlyArray<LogItem>>([]);
    return Effect.gen(function* () {
      yield* Effect.logDebug("quiet");
      yield* Effect.logInfo("loud");

      const items = yield* Ref.get(tapped);
      assert.deepStrictEqual(
        items.map((item) => [item.level, item.message]),
        [
          [LogLevel.DEBUG, "quiet"],
          [LogLevel.INFO, "loud"],
        ],
      );

      const captured = yield* Logger.captured;
      assert.deepStrictEqual(
        captured.map((item) => item.message),
        ["loud"],
      );
    }).pipe(
      Effect.provide(
        withAdapter(
          Logger.layerCapture({ level: LogLevel.INFO, onLog: tapInto(tapped) }),
        ),
      ),
    );
  });

  it.effect("appends the cause to the args as a string", () =>
    Effect.gen(function* () {
      yield* Effect.logError("x", Cause.fail(new Error("bad")));

      const items = yield* Logger.captured;
      assert.strictEqual(items[0]!.level, LogLevel.ERROR);
      assert.strictEqual(items[0]!.message, "x");
      assert.strictEqual(items[0]!.args.length, 1);
      assert.isString(items[0]!.args[0]);
      assert.include(String(items[0]!.args[0]), "bad");
    }).pipe(Effect.provide(withAdapter(Logger.layerCapture()))),
  );

  it.effect("maps Effect log levels onto the mitools levels", () =>
    Effect.gen(function* () {
      yield* Effect.logTrace("trace");
      yield* Effect.logDebug("debug");
      yield* Effect.logInfo("info");
      yield* Effect.logWarning("warning");
      yield* Effect.logError("error");
      yield* Effect.logFatal("fatal");

      const items = yield* Logger.captured;
      assert.deepStrictEqual(
        items.map((item) => item.level),
        [
          LogLevel.DEBUG,
          LogLevel.DEBUG,
          LogLevel.INFO,
          LogLevel.WARN,
          LogLevel.ERROR,
          LogLevel.ERROR,
        ],
      );
    }).pipe(
      Effect.provide(withAdapter(Logger.layerCapture({ level: LogLevel.DEBUG }))),
    ),
  );
});

describe("Logger hook reentrancy", () => {
  it.effect("a tap that logs does not re-run the tap or the hooks", () =>
    Effect.gen(function* () {
      const tapCalls = yield* Ref.make(0);
      const hookCalls = yield* Ref.make(0);
      const layer = Logger.layerAdapter.pipe(
        Layer.provideMerge(
          Logger.layerCapture({
            level: LogLevel.DEBUG,
            onLog: () =>
              Ref.update(tapCalls, (n) => n + 1).pipe(
                // A tap that persists lines would log while doing so.
                Effect.andThen(Effect.logError("inside tap")),
              ),
            onError: () => Ref.update(hookCalls, (n) => n + 1),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        yield* Logger.named("T").error("outer");
        yield* Logger.flush;
        const captured = yield* Logger.captured;
        // The tap runs before the outer line is recorded, so order is tap-first.
        assert.deepStrictEqual(captured.map((item) => item.message).sort(), [
          "inside tap",
          "outer",
        ]);
      }).pipe(Effect.provide(layer));
      assert.strictEqual(yield* Ref.get(tapCalls), 1);
      assert.strictEqual(yield* Ref.get(hookCalls), 1);
    }),
  );
});
