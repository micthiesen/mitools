import { closeSync, openSync, readSync } from "node:fs";
import { Readable } from "node:stream";
import { Clock, Effect, Stream } from "effect";
import { type OperationError, operationErrors } from "../errors/index.js";

const io = operationErrors("streams");

/** Collects all chunks from a Readable stream into a single Buffer. Interruption destroys the stream. */
export function streamToBuffer(
  stream: Readable,
): Effect.Effect<Buffer, OperationError> {
  return Effect.callback<Buffer, OperationError>((resume) => {
    const chunks: Uint8Array[] = [];
    const detach = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onData = (chunk: Uint8Array) => chunks.push(chunk);
    const onEnd = () => {
      detach();
      resume(Effect.succeed(Buffer.concat(chunks)));
    };
    const onError = (cause: unknown) => {
      detach();
      resume(Effect.fail(io.wrap("streamToBuffer")(cause)));
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    // Runs on interruption only: a completed or failed stream needs no destroy.
    return Effect.sync(() => {
      detach();
      stream.destroy();
    });
  });
}

/** A Node `Readable` as an Effect `Stream` of byte chunks. */
export function fromReadable(
  stream: Readable,
): Stream.Stream<Uint8Array, OperationError> {
  return Stream.fromReadableStream({
    evaluate: () => Readable.toWeb(stream) as ReadableStream<Uint8Array>,
    onError: io.wrap("fromReadable"),
  });
}

/**
 * Reads `len` bytes at byte offset `start` from an open file descriptor,
 * decoded as UTF-8. A short read (a signal can cut one short) is sliced to the
 * bytes actually read, so the decoder never sees the buffer's zero-filled tail
 * as NUL characters.
 */
export const readFdSlice = Effect.fn("streams.readFdSlice")(function* (
  fd: number,
  start: number,
  len: number,
): Effect.fn.Return<string, OperationError> {
  return yield* io.sync("readFdSlice", () => {
    const buffer = Buffer.alloc(len);
    const read = readSync(fd, buffer, 0, len, start);
    return buffer.toString("utf8", 0, read);
  });
});

/**
 * Reads `len` bytes at byte offset `start` of `path`, opening and closing its
 * own descriptor. The tail-by-offset primitive: remember the offset you stopped
 * at and ask for the bytes after it.
 */
export const readFileSlice = Effect.fn("streams.readFileSlice")(function* (
  path: string,
  start: number,
  len: number,
): Effect.fn.Return<string, OperationError> {
  return yield* Effect.acquireUseRelease(
    io.sync(`open ${path}`, () => openSync(path, "r")),
    (fd) => readFdSlice(fd, start, len),
    // A failing close would otherwise mask the read's own failure.
    (fd) => Effect.ignore(io.sync(`close ${path}`, () => closeSync(fd))),
  );
});

/** The `timestamp` field of a jsonl envelope, when it is a parseable string. */
function parseTimestamp(entry: Record<string, unknown>): number | null {
  const timestamp = entry.timestamp;
  if (typeof timestamp !== "string") return null;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Timestamp of a jsonl log envelope: its `timestamp` field when present and
 * parseable, else the current time. An entry with no usable stamp still has to
 * sort somewhere, and "now" keeps it at the fresh end.
 */
export const jsonlTimestamp = Effect.fn("streams.jsonlTimestamp")(function* (
  entry: Record<string, unknown>,
): Effect.fn.Return<number> {
  return parseTimestamp(entry) ?? (yield* Clock.currentTimeMillis);
});
