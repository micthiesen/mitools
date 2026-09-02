import { Readable } from "node:stream";
import { Effect, Stream } from "effect";
import { OperationError } from "../errors/index.js";

const wrap = (operation: string) => (cause: unknown) =>
  new OperationError({ source: "streams", operation, cause });

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
      resume(Effect.fail(wrap("streamToBuffer")(cause)));
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
    onError: wrap("fromReadable"),
  });
}
