import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Result, Stream } from "effect";
import { TestClock } from "effect/testing";
import { OperationError } from "../errors/index.js";
import {
  fromReadable,
  jsonlTimestamp,
  readFdSlice,
  readFileSlice,
  streamToBuffer,
} from "./index.js";

const root = mkdtempSync(join(tmpdir(), "mitools-streams-"));
let counter = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a fixture file and resolves its path. */
function fixture(name: string, contents: string): string {
  const path = join(root, `${counter++}-${name}`);
  writeFileSync(path, contents);
  return path;
}

/** A readable that emits one chunk and then fails. */
const failing = () =>
  new Readable({
    read() {
      this.push(Buffer.from("partial"));
      this.destroy(new Error("stream broke"));
    },
  });

/** A readable that never emits and never ends until it is destroyed. */
const pending = () => new Readable({ read() {} });

describe("streamToBuffer", () => {
  it.live("concatenates every chunk", () =>
    Effect.gen(function* () {
      const source = Readable.from([
        Buffer.from("hello "),
        Buffer.from("wonderful "),
        Buffer.from("world"),
      ]);
      const buffer = yield* streamToBuffer(source);
      assert.strictEqual(buffer.toString("utf8"), "hello wonderful world");
    }),
  );

  it.live("returns an empty buffer for an empty stream", () =>
    Effect.gen(function* () {
      const buffer = yield* streamToBuffer(Readable.from([]));
      assert.strictEqual(buffer.length, 0);
    }),
  );

  it.live("fails with an OperationError when the stream errors", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(streamToBuffer(failing()));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, OperationError);
        assert.strictEqual(result.failure._tag, "OperationError");
        assert.strictEqual(result.failure.source, "streams");
        assert.strictEqual(result.failure.operation, "streamToBuffer");
        assert.include(result.failure.message, "stream broke");
      }
    }),
  );

  it.live("destroys the source stream when interrupted", () =>
    Effect.gen(function* () {
      const source = pending();
      const fiber = yield* Effect.forkChild(streamToBuffer(source));
      yield* Effect.sleep("10 millis");
      assert.isFalse(source.destroyed);

      yield* Fiber.interrupt(fiber);
      assert.isTrue(source.destroyed);
    }),
  );
});

describe("fromReadable", () => {
  it.live("emits every chunk of the readable", () =>
    Effect.gen(function* () {
      const source = Readable.from([Buffer.from("one "), Buffer.from("two")]);
      const chunks = yield* Stream.runCollect(fromReadable(source));

      assert.strictEqual(
        chunks.map((chunk) => Buffer.from(chunk).toString("utf8")).join(""),
        "one two",
      );
    }),
  );

  it.live("fails with an OperationError when the stream errors", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(Stream.runCollect(fromReadable(failing())));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, OperationError);
        assert.strictEqual(result.failure.source, "streams");
        assert.strictEqual(result.failure.operation, "fromReadable");
      }
    }),
  );

  it.live("destroys the source stream when interrupted", () =>
    Effect.gen(function* () {
      const source = pending();
      const fiber = yield* Effect.forkChild(Stream.runCollect(fromReadable(source)));
      yield* Effect.sleep("10 millis");

      yield* Fiber.interrupt(fiber);
      yield* Effect.sleep("10 millis");
      assert.isTrue(source.destroyed);
    }),
  );
});

describe("readFdSlice", () => {
  it.live("reads a byte range from an open descriptor", () =>
    Effect.gen(function* () {
      const fd = openSync(fixture("fd.txt", "hello wonderful world"), "r");
      const slice = yield* readFdSlice(fd, 6, 9);
      closeSync(fd);

      assert.strictEqual(slice, "wonderful");
    }),
  );

  it.live("slices the buffer to the bytes actually read", () =>
    Effect.gen(function* () {
      const fd = openSync(fixture("short.txt", "abc"), "r");
      const slice = yield* readFdSlice(fd, 1, 64);
      closeSync(fd);

      assert.strictEqual(slice, "bc");
    }),
  );
});

describe("readFileSlice", () => {
  it.live("reads a byte range and closes its own descriptor", () =>
    Effect.gen(function* () {
      const path = fixture("slice.txt", "0123456789");
      assert.strictEqual(yield* readFileSlice(path, 3, 4), "3456");
      // Offsets are bytes, so a second read continues where the first stopped.
      assert.strictEqual(yield* readFileSlice(path, 7, 100), "789");
    }),
  );

  it.live("counts offsets in bytes, not characters", () =>
    Effect.gen(function* () {
      const path = fixture("utf8.txt", "\u00e9\u00e9x");
      assert.strictEqual(yield* readFileSlice(path, 4, 1), "x");
    }),
  );

  it.live("fails with an OperationError when the file cannot be opened", () =>
    Effect.gen(function* () {
      const path = join(root, "does-not-exist.txt");
      const result = yield* Effect.result(readFileSlice(path, 0, 10));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, OperationError);
        assert.strictEqual(result.failure.source, "streams");
        assert.strictEqual(result.failure.operation, `open ${path}`);
      }
    }),
  );
});

describe("jsonlTimestamp", () => {
  it.effect("uses a parseable timestamp field", () =>
    Effect.gen(function* () {
      const stamp = yield* jsonlTimestamp({ timestamp: "2026-01-01T00:00:00.000Z" });
      assert.strictEqual(stamp, 1_767_225_600_000);
    }),
  );

  it.effect("falls back to the current time", () =>
    Effect.gen(function* () {
      const now = 1_800_000_000_000;
      yield* TestClock.setTime(now);

      assert.strictEqual(yield* jsonlTimestamp({}), now);
      assert.strictEqual(yield* jsonlTimestamp({ timestamp: "nonsense" }), now);
      assert.strictEqual(yield* jsonlTimestamp({ timestamp: 12 }), now);
    }),
  );
});
