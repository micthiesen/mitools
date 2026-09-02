/**
 * Cross-process file locks.
 *
 * A lock is one file, created atomically with `open(path, "wx")`, whose
 * contents are the JSON metadata of its holder (`LockMeta`). Node has no
 * `flock`, so liveness is not enforced by the kernel: a holder that dies
 * without releasing leaves its file behind, and the next acquirer reclaims it
 * by staleness. A lock counts as stale when the recorded pid is no longer
 * running on this host, or when the file has not been touched for `staleMs`
 * (15 minutes by default, 60 seconds when the file holds no readable pid).
 *
 * Every lock path is an explicit argument: this module owns no directory and
 * reads no configuration.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { Clock, Data, DateTime, Effect, Option, type Scope } from "effect";
import { lockContention } from "../async/index.js";
import { causeMessage } from "../errors/index.js";

/** A lock older than this (by file mtime) is reclaimed. */
const DEFAULT_STALE_MS = 15 * 60_000;
/** Staleness bound for a lock file whose pid cannot be read. */
const UNREADABLE_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 150;
const DEFAULT_TIMEOUT_MS = 120_000;

/** What a lock file records about its holder. */
export interface LockMeta {
  /** The operation holding the lock, for display: "update", "merge", ... */
  readonly op: string;
  /** Optional finer-grained step within `op`; "" when the holder set none. */
  readonly phase: string;
  /** Process id of the holder, used for liveness detection. */
  readonly pid: number;
  /** Hostname of the holder; pid liveness is only meaningful on the same host. */
  readonly host: string;
  /** ISO timestamp of the acquisition. */
  readonly startedAt: string;
  /** ISO timestamp of the current phase. */
  readonly phaseStarted: string;
}

/** Which step of the lock lifecycle failed. */
export type LockOperation = "acquire" | "wait" | "release";

/**
 * A lock could not be taken or written. `operation` is `"wait"` when the
 * acquire timed out against a live holder, and `"acquire"` when the lock file
 * itself could not be created or rewritten. `"release"` completes the lifecycle
 * for consumers that match exhaustively: releasing swallows its filesystem
 * errors, since staleness detection recovers a lock file left behind.
 */
export class LockError extends Data.TaggedError("LockError")<{
  readonly path: string;
  readonly operation: LockOperation;
  readonly cause: unknown;
}> {
  override get message(): string {
    if (this.operation === "wait") return `timed out waiting for lock ${this.path}`;
    const verb = this.operation === "acquire" ? "acquire" : "release";
    return `could not ${verb} lock ${this.path}: ${causeMessage(this.cause)}`;
  }
}

/** An acquired lock. The scope that acquired it releases it. */
export interface LockHandle {
  /** The lock file this handle owns. */
  readonly path: string;
  /**
   * Records a new phase in the lock file, which also refreshes its mtime so a
   * long operation is never mistaken for a stale one. A no-op after `release`.
   * Fails with `operation: "acquire"` when the rewrite fails.
   */
  phase(description: string): Effect.Effect<void, LockError>;
  /**
   * Gives the lock up. Idempotent, never fails, and never deletes a lock file
   * that another holder has since reclaimed.
   */
  readonly release: Effect.Effect<void>;
}

/** Options for a single acquire attempt. */
export interface AcquireOptions {
  /** The operation to record in the lock file. */
  readonly op: string;
  /** Initial phase within `op`. Defaults to "". */
  readonly phase?: string;
  /** Age past which a lock file is reclaimed. Defaults to 15 minutes. */
  readonly staleMs?: number;
}

/** Options for an acquire that waits out a live holder. */
export interface WaitOptions extends AcquireOptions {
  /** Interval between attempts, jittered. Defaults to 150 ms. */
  readonly pollMs?: number;
  /** How long to keep trying before failing with `operation: "wait"`. Defaults to 2 minutes. */
  readonly timeoutMs?: number;
}

const isErrno = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as NodeJS.ErrnoException).code === code;

/** JSON that is not an object is as useless as no lock file at all. */
function parseMeta(raw: string): Partial<LockMeta> {
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return {};
  return parsed as Partial<LockMeta>;
}

/**
 * Metadata of the lock file at `path`. Never fails: an absent, empty, or
 * unparseable file reads as `{}`, which every caller here treats as "a lock
 * whose holder cannot be identified".
 */
export const readLockMeta = Effect.fn("locks.readLockMeta")(function* (
  path: string,
): Effect.fn.Return<Partial<LockMeta>> {
  return yield* Effect.try(() => parseMeta(readFileSync(path, "utf8"))).pipe(
    Effect.orElseSucceed((): Partial<LockMeta> => ({})),
  );
});

/**
 * Whether `pid` is a running process. A pid we are not allowed to signal
 * (EPERM) belongs to another user and is very much alive.
 */
function pidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

/** Age of the lock file in ms, or `None` when it cannot be stat'ed. */
const lockFileAgeMs = (
  path: string,
  nowMs: number,
): Effect.Effect<Option.Option<number>> =>
  Effect.option(Effect.try(() => nowMs - statSync(path).mtimeMs));

/**
 * Whether the lock file at `path` may be taken over: its holder is a dead
 * process on this host, or the file has gone untouched for too long.
 */
const isStale = Effect.fnUntraced(function* (path: string, staleMs: number) {
  const meta = yield* readLockMeta(path);
  const pid = typeof meta.pid === "number" ? meta.pid : null;
  const sameHost = meta.host === undefined || meta.host === hostname();
  if (pid !== null && sameHost && !pidIsAlive(pid)) return true;
  const now = yield* Clock.currentTimeMillis;
  const age = yield* lockFileAgeMs(path, now);
  const limit = pid === null ? UNREADABLE_STALE_MS : staleMs;
  return Option.isSome(age) && age.value > limit;
});

/** Deletes the lock file, ignoring a file that is already gone. */
const removeLock = (path: string): Effect.Effect<void> =>
  Effect.ignore(Effect.try(() => unlinkSync(path)));

/**
 * Creates the lock file exclusively. Resolves false when it already exists;
 * any other filesystem failure is a `LockError`.
 */
const createLock = (path: string, meta: LockMeta): Effect.Effect<boolean, LockError> =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, JSON.stringify(meta));
      } finally {
        closeSync(fd);
      }
      return true;
    },
    catch: (cause) => new LockError({ path, operation: "acquire", cause }),
  }).pipe(
    Effect.catchIf(
      (error) => isErrno(error.cause, "EEXIST"),
      () => Effect.succeed(false),
    ),
  );

function makeHandle(path: string, meta: LockMeta): LockHandle {
  let current = meta;
  let released = false;

  const rewrite = (next: LockMeta): Effect.Effect<void, LockError> =>
    Effect.try({
      try: () => writeFileSync(path, JSON.stringify(next)),
      catch: (cause) => new LockError({ path, operation: "acquire", cause }),
    });

  return {
    path,
    phase: (description: string) =>
      Effect.suspend(() => {
        if (released) return Effect.void;
        if (description === current.phase) return rewrite(current);
        return DateTime.now.pipe(
          Effect.flatMap((now) => {
            current = {
              ...current,
              phase: description,
              phaseStarted: DateTime.formatIso(now),
            };
            return rewrite(current);
          }),
        );
      }),
    release: Effect.suspend(() => {
      if (released) return Effect.void;
      released = true;
      // Only delete a file that is still ours: a lock reclaimed as stale while
      // we were wedged now belongs to somebody else.
      return Effect.ignore(
        Effect.try(() => {
          const held = parseMeta(readFileSync(path, "utf8"));
          if (held.pid === current.pid && held.startedAt === current.startedAt) {
            unlinkSync(path);
          }
        }),
      );
    }),
  };
}

/** One acquire attempt, with a single immediate retry after reclaiming a stale lock. */
const acquireOnce = Effect.fnUntraced(function* (
  path: string,
  options: AcquireOptions,
) {
  const now = yield* DateTime.now;
  const stamp = DateTime.formatIso(now);
  const meta: LockMeta = {
    op: options.op,
    phase: options.phase ?? "",
    pid: process.pid,
    host: hostname(),
    startedAt: stamp,
    phaseStarted: stamp,
  };
  if (yield* createLock(path, meta)) return Option.some(makeHandle(path, meta));

  if (!(yield* isStale(path, options.staleMs ?? DEFAULT_STALE_MS))) {
    return Option.none<LockHandle>();
  }
  yield* removeLock(path);
  return (yield* createLock(path, meta))
    ? Option.some(makeHandle(path, meta))
    : Option.none<LockHandle>();
});

/**
 * Takes the lock at `path` if it is free or stale, without waiting. Scoped:
 * closing the scope releases the lock. Resolves `None` while a live holder
 * has it.
 */
export const tryAcquireLock = Effect.fn("locks.tryAcquireLock")(function* (
  path: string,
  options: AcquireOptions,
): Effect.fn.Return<Option.Option<LockHandle>, LockError, Scope.Scope> {
  return yield* Effect.acquireRelease(acquireOnce(path, options), (handle) =>
    Option.isSome(handle) ? handle.value.release : Effect.void,
  );
});

/** Retries `acquireOnce` on the shared lock-contention schedule until it wins or times out. */
const waitForLock = Effect.fnUntraced(function* (path: string, options: WaitOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  return yield* Effect.flatMap(acquireOnce(path, options), (handle) =>
    Effect.fromOption(
      handle,
      () => new LockError({ path, operation: "wait", cause: undefined }),
    ),
  ).pipe(
    Effect.retry({
      schedule: lockContention(timeoutMs, pollMs),
      while: (error: LockError) => error.operation === "wait",
    }),
  );
});

/**
 * Waits for the lock at `path` and holds it for the rest of the scope. Fails
 * with `operation: "wait"` once `timeoutMs` elapses against a live holder.
 */
export const acquireLock = Effect.fn("locks.acquireLock")(function* (
  path: string,
  options: WaitOptions,
): Effect.fn.Return<LockHandle, LockError, Scope.Scope> {
  return yield* Effect.acquireRelease(
    waitForLock(path, options),
    (handle) => handle.release,
  );
});

/**
 * Runs `effect` while holding the lock at `path`, waiting up to `timeoutMs`
 * for a live holder to finish. The lock is released on success, failure and
 * interruption alike.
 */
export const withLock = Effect.fn("locks.withLock")(function* <A, E, R>(
  path: string,
  effect: Effect.Effect<A, E, R>,
  options: WaitOptions,
): Effect.fn.Return<A, E | LockError, R> {
  return yield* Effect.acquireUseRelease(
    waitForLock(path, options),
    () => effect,
    (handle) => handle.release,
  );
});

/**
 * Metadata of the live holder of `path`, or `None` when the lock is free or
 * stale enough that the next acquire would reclaim it.
 */
export const lockStatus = Effect.fn("locks.lockStatus")(function* (
  path: string,
  options: { readonly staleMs?: number } = {},
): Effect.fn.Return<Option.Option<Partial<LockMeta>>> {
  const exists = yield* Effect.try(() => statSync(path)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!exists) return Option.none();
  if (yield* isStale(path, options.staleMs ?? DEFAULT_STALE_MS)) return Option.none();
  return Option.some(yield* readLockMeta(path));
});

/** Coarse duration for display: "45s", "3m", "2h", "5d". */
export function humanAge(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * How long the holder has been in its current phase, as of `nowMs`. Null when
 * the metadata carries no parseable timestamp. Pure, so pass
 * `yield* Clock.currentTimeMillis`.
 */
export function lockAge(meta: Partial<LockMeta>, nowMs: number): string | null {
  const started = meta.phaseStarted ?? meta.startedAt;
  if (!started) return null;
  const parsed = Date.parse(started);
  if (Number.isNaN(parsed)) return null;
  return humanAge((nowMs - parsed) / 1000);
}

/** One-line description of a holder: "op: phase", the op, or "busy". */
export function lockLabel(meta: Partial<LockMeta>): string {
  const { phase, op } = meta;
  if (phase && op && phase !== op) return `${op}: ${phase}`;
  return phase || op || "busy";
}
