import { Readable } from "node:stream";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Result, Stream } from "effect";
import { OperationError } from "../errors/index.js";
import { fromReadable, streamToBuffer } from "./index.js";

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
