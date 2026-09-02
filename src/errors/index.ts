/**
 * Shared error helpers. Leaf module: no config, no I/O, so every other module
 * (and every consumer) can import it.
 */
import { Data, Effect } from "effect";

/** Human-readable text for an arbitrary thrown/failed value. */
export function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  if (typeof cause === "string") return cause;
  if (
    cause !== null &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

/**
 * The one wrapper for code that crosses an untyped boundary: a synchronous call
 * that may throw (better-sqlite3, cbor, `node:fs`), a Promise API, a dynamic
 * `import()`. `source` names the module, `operation` the step; the message
 * reads `operation: cause` so a boundary renderer never prints a bare tag.
 *
 * Domain failures with fields consumers match on (`CorruptRowError`,
 * `PushoverError`, `InvalidScheduleError`, ...) stay their own tagged classes.
 * This exists so a module does not mint a per-file `XError { cause: unknown }`
 * that nothing ever matches by tag.
 */
export class OperationError extends Data.TaggedError("OperationError")<{
  readonly source: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.operation}: ${causeMessage(this.cause)}`;
  }
}

export interface OperationErrors {
  /** `Effect.mapError` / `catch` callback that tags a failure. */
  readonly wrap: (operation: string) => (cause: unknown) => OperationError;
  /** Run a synchronous, possibly-throwing computation. */
  readonly sync: <A>(
    operation: string,
    evaluate: () => A,
  ) => Effect.Effect<A, OperationError>;
  /** Adopt a Promise API. Interruption aborts the signal. */
  readonly promise: <A>(
    operation: string,
    evaluate: (signal: AbortSignal) => PromiseLike<A>,
  ) => Effect.Effect<A, OperationError>;
}

/** Per-module boundary helpers: `const io = operationErrors("docstore")`. */
export function operationErrors(source: string): OperationErrors {
  const wrap = (operation: string) => (cause: unknown) =>
    new OperationError({ source, operation, cause });
  return {
    wrap,
    sync: (operation, evaluate) =>
      Effect.try({ try: evaluate, catch: wrap(operation) }),
    promise: (operation, evaluate) =>
      Effect.tryPromise({ try: evaluate, catch: wrap(operation) }),
  };
}
