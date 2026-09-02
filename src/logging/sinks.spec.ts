import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { Logger } from "./Logger.js";
import { channelSink, formatFileLine, levelSink, sanitizeControl } from "./sinks.js";
import { type LogItem, LogLevel, type LogSink } from "./types.js";

const recording = (into: Ref.Ref<ReadonlyArray<string>>, tag: string): LogSink => ({
  write: (item) =>
    Ref.update(into, (lines) => [
      ...lines,
      `${tag}:${item.channel ?? "-"}:${item.message}`,
    ]),
});

describe("Logger sinks", () => {
  it.effect("every sink sees every line in order, with the channel", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const pane = recording(seen, "pane");
      const toast = channelSink(recording(seen, "toast"), "attention");
      const log = Logger.named("Main");
      yield* Effect.gen(function* () {
        yield* log.info("plain");
        yield* log.channel("attention").warn("look");
        yield* log
          .channel("attention")
          .extend("Child")
          .error("child keeps the channel");
        yield* log.channel("attention").channel(null).info("back to default");
      }).pipe(Effect.provide(Logger.layer({ sinks: [pane, toast] })));
      assert.deepStrictEqual(yield* Ref.get(seen), [
        "pane:-:plain",
        "pane:attention:look",
        "toast:attention:look",
        "pane:attention:child keeps the channel",
        "toast:attention:child keeps the channel",
        "pane:-:back to default",
      ]);
    }),
  );

  it.effect("a failing sink is reported and the next sink still runs", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const broken: LogSink = { write: () => Effect.die(new Error("disk gone")) };
      yield* Logger.named("Main")
        .info("still delivered")
        .pipe(Effect.provide(Logger.layer({ sinks: [broken, recording(seen, "ok")] })));
      assert.deepStrictEqual(yield* Ref.get(seen), ["ok:-:still delivered"]);
      const errors = yield* TestConsole.errorLines;
      assert.include(String(errors[0]), "Logger sink failed");
    }),
  );

  it.effect("levelSink filters below its own threshold", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const log = Logger.named("Main");
      yield* Effect.gen(function* () {
        yield* log.info("info");
        yield* log.error("error");
      }).pipe(
        Effect.provide(
          Logger.layer({
            sinks: [levelSink(recording(seen, "errors"), LogLevel.ERROR)],
          }),
        ),
      );
      assert.deepStrictEqual(yield* Ref.get(seen), ["errors:-:error"]);
    }),
  );

  it.effect("layerCapture keeps extra sinks", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        yield* Logger.named("Main").info("both");
        const captured = yield* Logger.captured;
        assert.strictEqual(captured.length, 1);
      }).pipe(
        Effect.provide(Logger.layerCapture({ sinks: [recording(seen, "extra")] })),
      );
      assert.deepStrictEqual(yield* Ref.get(seen), ["extra:-:both"]);
    }),
  );
});

describe("formatFileLine", () => {
  it.effect("formats level, channel, name, args and indents continuation lines", () =>
    Effect.sync(() => {
      const item: LogItem = {
        timestamp: Date.UTC(2026, 2, 4, 12, 0, 0),
        level: LogLevel.WARN,
        loggerName: "Main",
        message: "first\nsecond",
        args: [{ a: 1 }],
        formattedArgs: '{"a":1}',
        channel: "attention",
      };
      assert.strictEqual(
        formatFileLine(item),
        `2026-03-04T12:00:00.000Z WARN  attention ${"Main".padEnd(16)} first\n        second {"a":1}`,
      );
      assert.strictEqual(sanitizeControl("a\0b\x1bc\td"), "a�b�c\td");
    }),
  );
});

describe("Logger.dailyFileSink", () => {
  const localDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const withDir = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "mitools-logsink-"))),
      f,
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );

  it.effect("appends one line per item to the day's file and flush waits for it", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const now = Date.UTC(2026, 2, 4, 12, 0, 0);
        yield* TestClock.setTime(now);
        const layer = Logger.layer({
          level: LogLevel.DEBUG,
          sinks: [
            Logger.dailyFileSink({ directory: join(dir, "logs"), prefix: "app" }),
          ],
        });
        yield* Effect.gen(function* () {
          const log = Logger.named("Main");
          yield* log.debug("one");
          yield* log.channel("attention").info("two", { n: 2 });
          yield* Logger.flush;
          const text = readFileSync(
            join(dir, "logs", `app-${localDate(now)}.log`),
            "utf8",
          );
          assert.deepStrictEqual(text.split("\n"), [
            `2026-03-04T12:00:00.000Z DEBUG ${"Main".padEnd(16)} one`,
            `2026-03-04T12:00:00.000Z INFO  attention ${"Main".padEnd(16)} two {"n":2}`,
            "",
          ]);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect("the layer scope flushes queued lines before closing", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const now = Date.UTC(2026, 2, 4, 12, 0, 0);
        yield* TestClock.setTime(now);
        yield* Logger.named("Main")
          .info("last words")
          .pipe(
            Effect.provide(
              Logger.layer({
                sinks: [Logger.dailyFileSink({ directory: dir, prefix: "app" })],
              }),
            ),
          );
        const text = readFileSync(join(dir, `app-${localDate(now)}.log`), "utf8");
        assert.include(text, "last words");
      }),
    ),
  );

  // Wall-clock time, read outside Effect code: the files' mtimes are real.
  const wallNow = Date.now();

  it.effect("unlinks files older than retainDays on the first write", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const now = wallNow;
        yield* TestClock.setTime(now);
        const day = 24 * 60 * 60 * 1000;
        const old = join(dir, "app-2020-01-01.log");
        const fresh = join(dir, "app-2026-01-01.log");
        const other = join(dir, "other-2020-01-01.log");
        for (const path of [old, fresh, other]) writeFileSync(path, "x\n");
        const twentyDaysAgo = (now - 20 * day) / 1000;
        utimesSync(old, twentyDaysAgo, twentyDaysAgo);
        utimesSync(other, twentyDaysAgo, twentyDaysAgo);
        yield* Logger.named("Main")
          .info("hello")
          .pipe(
            Effect.provide(
              Logger.layer({
                sinks: [
                  Logger.dailyFileSink({
                    directory: dir,
                    prefix: "app",
                    retainDays: 14,
                  }),
                ],
              }),
            ),
          );
        const names = readdirSync(dir).sort();
        assert.deepStrictEqual(
          names,
          [
            `app-${localDate(now)}.log`,
            "app-2026-01-01.log",
            "other-2020-01-01.log",
          ].sort(),
        );
      }),
    ),
  );

  it.effect("a write failure is reported once and never fails the log call", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const file = join(dir, "not-a-directory");
        writeFileSync(file, "");
        yield* Effect.gen(function* () {
          yield* Logger.named("Main").info("one");
          yield* Logger.named("Main").info("two");
          yield* Logger.flush;
        }).pipe(
          Effect.provide(
            Logger.layer({
              sinks: [Logger.dailyFileSink({ directory: file, prefix: "app" })],
            }),
          ),
        );
        const reports = (yield* TestConsole.errorLines).filter((line) =>
          String(line).includes("Logger file sink"),
        );
        // The mkdir failure and the append failure, each once, not once per line.
        assert.strictEqual(reports.length, 2);
      }),
    ),
  );
});
