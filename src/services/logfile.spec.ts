import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { Logger } from "../logging/index.js";
import { LogLevel } from "../logging/types.js";
import { LogFile } from "./logfile.js";

const root = mkdtempSync(join(tmpdir(), "mitools-logfile-"));
let counter = 0;
const tempPath = (name: string) => join(root, `${counter++}-${name}`);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (path: string) =>
  Effect.promise(() => readFile(path, "utf8")) as Effect.Effect<string>;

describe("LogFile", () => {
  it.live("truncates on the first section and appends afterwards", () =>
    Effect.gen(function* () {
      const path = tempPath("overwrite.log");
      yield* Effect.promise(() => writeFile(path, "stale content\n"));

      const logFile = yield* LogFile.make(path, "overwrite");
      yield* logFile.section("first", "one");
      yield* logFile.section("second", "two");

      const contents = yield* read(path);
      assert.strictEqual(contents, "## first\n\none\n\n## second\n\ntwo\n\n");
    }),
  );

  it.live("creates the parent directory", () =>
    Effect.gen(function* () {
      const path = join(root, `nested-${counter++}`, "deep", "log.log");
      const logFile = yield* LogFile.make(path, "overwrite");
      yield* logFile.section("first", "one");

      assert.strictEqual(yield* read(path), "## first\n\none\n\n");
      assert.strictEqual(logFile.filePath, path);
    }),
  );

  it.live("append mode never truncates existing content", () =>
    Effect.gen(function* () {
      const path = tempPath("append.log");
      yield* Effect.promise(() => writeFile(path, "existing\n"));

      const logFile = yield* LogFile.make(path, "append");
      yield* logFile.section("first", "one");
      yield* logFile.section("second", "two");

      const contents = yield* read(path);
      assert.strictEqual(contents, "existing\n## first\n\none\n\n## second\n\ntwo\n\n");
    }),
  );

  it.effect("timestamped names the file from the runtime clock", () =>
    Effect.gen(function* () {
      const directory = join(root, `timestamped-${counter++}`);
      yield* TestClock.setTime(Date.UTC(2026, 2, 16, 14, 30, 5));

      const logFile = yield* LogFile.timestamped(directory);
      assert.strictEqual(logFile.filePath, join(directory, "2026-03-16T14-30-05.log"));

      yield* logFile.section("first", "one");
      assert.strictEqual(yield* read(logFile.filePath), "## first\n\none\n\n");
    }),
  );

  it.live("log writes the section and logs the console summary", () =>
    Effect.gen(function* () {
      const path = tempPath("log.log");
      const logFile = yield* LogFile.make(path, "overwrite");
      const logger = Logger.named("Main").extend("Report");

      yield* logFile.log(logger, LogLevel.INFO, "report", "a very long report body", {
        consoleSummary: "wrote the report",
      });

      assert.strictEqual(yield* read(path), "## report\n\na very long report body\n\n");
      const captured = yield* Logger.captured;
      assert.strictEqual(captured.length, 1);
      assert.strictEqual(captured[0]?.level, LogLevel.INFO);
      assert.strictEqual(captured[0]?.loggerName, "Main:Report");
      assert.strictEqual(captured[0]?.message, "wrote the report");
    }).pipe(Effect.provide(Logger.layerCapture())),
  );

  it.live("falls back to the content when no console summary is given", () =>
    Effect.gen(function* () {
      const path = tempPath("log-no-summary.log");
      const logFile = yield* LogFile.make(path, "overwrite");

      yield* logFile.log(Logger.named("Main"), LogLevel.INFO, "report", "the body");

      const captured = yield* Logger.captured;
      assert.strictEqual(captured[0]?.message, "the body");
    }).pipe(Effect.provide(Logger.layerCapture())),
  );

  it.live("serializes concurrent sections so they never interleave", () =>
    Effect.gen(function* () {
      const path = tempPath("concurrent.log");
      const logFile = yield* LogFile.make(path, "overwrite");
      const sections = Array.from({ length: 20 }, (_, index) => ({
        heading: `section-${index}`,
        content: `${index}`.repeat(20_000),
      }));

      yield* Effect.forEach(
        sections,
        ({ heading, content }) => logFile.section(heading, content),
        { concurrency: "unbounded" },
      );

      const contents = yield* read(path);
      let expectedLength = 0;
      for (const { heading, content } of sections) {
        const block = `## ${heading}\n\n${content}\n\n`;
        assert.include(contents, block);
        expectedLength += block.length;
      }
      assert.strictEqual(contents.length, expectedLength);
    }),
  );
});
