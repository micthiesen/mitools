/**
 * Subprocess execution as Effects.
 *
 * Every function here returns an `Effect` with typed expected errors. The core
 * is `node:child_process`, spawned `detached` so the whole process GROUP can be
 * signalled: a shell that forks (`sh -c "cmd &"`) leaves descendants holding the
 * captured pipes, and killing only the direct child leaves the read blocked
 * until those descendants exit on their own.
 *
 * Four semantics here are load-bearing and were paid for with real incidents:
 *
 * 1. Bounded concurrency. `run` takes a permit from `ProcConcurrency` (8 by
 *    default). The acquire is masked so a cancelled queued caller can never
 *    leak a permit, and the permit is returned only after the child has been
 *    killed AND fully joined, so a released permit really means a free slot.
 * 2. Termination is SIGTERM to the group, a bounded grace period, SIGKILL to
 *    the group, then a full join of the exit and both stream drains.
 * 3. `timedOut` is a first-class discriminator. A SIGKILLed command's empty
 *    stdout is NOT an empty answer, and a caller that reads it as one (an
 *    `lsof` scan that found no listeners, say) silently does the wrong thing.
 * 4. An external `AbortSignal` is the compatibility boundary for Promise and
 *    TanStack callers. Native Effect callers interrupt the fiber instead, and
 *    the scoped finalizer kills and joins the child before interruption ends.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import type { Readable } from "node:stream";
import {
  Context,
  Data,
  Deferred,
  Effect,
  type Exit,
  Option,
  Ref,
  type Scope,
  Semaphore,
} from "effect";
import { causeMessage } from "../errors/index.js";

/** What a captured command produced. */
export type RunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** The `timeoutMs` budget fired and the process group was SIGKILLed. */
  readonly timedOut: boolean;
};

export type RunOptions = {
  /** Working directory. Defaults to the current process's cwd. */
  readonly cwd?: string;
  /** Written to the child's stdin, which is then closed. */
  readonly input?: string;
  /** Budget after which the process group is SIGKILLed and `timedOut` is set. */
  readonly timeoutMs?: number;
  /** Merged over `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Compatibility cancellation for Promise/TanStack callers. */
  readonly signal?: AbortSignal;
};

/** Streaming deliberately has no `signal` or `timeoutMs` compatibility fields. */
export type RunStreamingOptions = {
  /** Working directory. Defaults to the current process's cwd. */
  readonly cwd?: string;
  /** Merged over `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Called once per sanitized line of stdout and stderr, as they arrive. */
  readonly onLine?: (line: string) => void;
  /** Opt-in lifecycle deadline. The child is killed and fully joined. */
  readonly killAfterMs?: number;
};

/** The child could not be started at all. */
export class ProcSpawnError extends Data.TaggedError("ProcSpawnError")<{
  readonly argv: readonly string[];
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.argv.join(" ")}: ${causeMessage(this.cause)}`;
  }
}

/** One of the child's streams failed, or a line callback threw. */
export class ProcReadError extends Data.TaggedError("ProcReadError")<{
  readonly argv: readonly string[];
  readonly stream: "stdout" | "stderr" | "stdin";
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.argv.join(" ")} (${this.stream}): ${causeMessage(this.cause)}`;
  }
}

/** The command ran to completion with a nonzero exit code. */
export class ProcNonZeroExitError extends Data.TaggedError("ProcNonZeroExitError")<{
  readonly argv: readonly string[];
  readonly result: RunResult;
}> {
  override get message(): string {
    const detail =
      this.result.stderr.trim() ||
      this.result.stdout.trim() ||
      `exit ${this.result.exitCode}`;
    return `${this.argv.join(" ")}: ${detail}`;
  }
}

/** The command blew its `timeoutMs` budget and was killed. */
export class ProcTimeoutError extends Data.TaggedError("ProcTimeoutError")<{
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly result: RunResult;
}> {
  override get message(): string {
    return `${this.argv.join(" ")}: timed out after ${this.timeoutMs}ms`;
  }
}

/** An external `AbortSignal` cancelled the command. */
export class ProcInterruptedError extends Data.TaggedError("ProcInterruptedError")<{
  readonly argv: readonly string[];
}> {
  override get message(): string {
    return `${this.argv.join(" ")}: aborted`;
  }
}

/** Every expected failure the functions in this module can produce. */
export type ProcError =
  | ProcSpawnError
  | ProcReadError
  | ProcNonZeroExitError
  | ProcTimeoutError
  | ProcInterruptedError;

const DEFAULT_CONCURRENCY = 8;
const TERMINATION_GRACE_MS = 1_000;

/**
 * How many `run` calls may hold a live child at once. The default is a shared
 * 8-permit semaphore; override it for a whole program with
 * `Effect.provideService(ProcConcurrency, Semaphore.makeUnsafe(n))`.
 */
export const ProcConcurrency = Context.Reference<Semaphore.Semaphore>(
  "@micthiesen/mitools/ProcConcurrency",
  { defaultValue: () => Semaphore.makeUnsafe(DEFAULT_CONCURRENCY) },
);

/** A child killed by a signal reports the shell's `128 + signal` convention. */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal === null) return -1;
  const numbers: Record<string, number | undefined> = constants.signals;
  const number = numbers[signal];
  return number === undefined ? -1 : 128 + number;
}

function spawnEnv(
  env: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  return env === undefined ? process.env : { ...process.env, ...env };
}

/**
 * Signal the child's whole process group, falling back to the child alone when
 * it never became a group leader. Never throws: a process may exit between the
 * decision to signal and the signal itself.
 *
 * Deliberately unguarded by the child's own exit status. `sh -c "cmd &"` exits
 * immediately while its descendant keeps the captured pipes open, so the group
 * is exactly what still needs killing after the direct child is already gone.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group is gone, or the child never became its leader.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child already exited.
  }
}

interface ChildLifecycle {
  /** Succeeds once the child is running, fails if it never started. */
  readonly started: Effect.Effect<void, ProcSpawnError>;
  /** Completes with the exit code. Awaitable any number of times. */
  readonly exited: Effect.Effect<number>;
}

/**
 * Turn the child's `spawn`, `error` and `exit` events into two awaitable
 * effects. Node reports a failed spawn (a missing binary, a missing cwd)
 * asynchronously on `error`, so `started` is what separates a typed
 * `ProcSpawnError` from a child that is genuinely running.
 */
function watchChild(argv: readonly string[], child: ChildProcess): ChildLifecycle {
  const started = Deferred.makeUnsafe<void, ProcSpawnError>();
  const exited = Deferred.makeUnsafe<number>();
  let running = false;

  child.once("spawn", () => {
    running = true;
    Deferred.doneUnsafe(started, Effect.void);
  });
  child.on("error", (cause) => {
    if (running) return;
    Deferred.doneUnsafe(started, Effect.fail(new ProcSpawnError({ argv, cause })));
    Deferred.doneUnsafe(exited, Effect.succeed(-1));
  });
  child.once("exit", (code, signal) => {
    running = true;
    Deferred.doneUnsafe(started, Effect.void);
    Deferred.doneUnsafe(exited, Effect.succeed(exitCodeOf(code, signal)));
  });

  return { started: Deferred.await(started), exited: Deferred.await(exited) };
}

/** One captured stream: its full text, or the error that ended it early. */
type StreamCapture =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly cause: unknown };

interface CapturedProcess {
  readonly stdout: StreamCapture;
  readonly stderr: StreamCapture;
  readonly exitCode: number;
}

interface RunningProcess {
  readonly child: ChildProcess;
  /**
   * Completes when stdout, stderr and the child itself have all settled.
   * Awaitable any number of times, so join and terminate share one join.
   */
  readonly settled: Effect.Effect<CapturedProcess>;
}

/** Accumulate a stream's whole text, killing the group if the read fails. */
function captureStream(
  child: ChildProcess,
  stream: Readable | null,
): Effect.Effect<StreamCapture> {
  if (stream === null) return Effect.succeed({ ok: true, text: "" });
  const done = Deferred.makeUnsafe<StreamCapture>();
  const decoder = new TextDecoder();
  let text = "";
  stream.on("data", (chunk: Uint8Array) => {
    text += decoder.decode(chunk, { stream: true });
  });
  stream.once("end", () => {
    text += decoder.decode();
    Deferred.doneUnsafe(done, Effect.succeed({ ok: true, text }));
  });
  stream.once("error", (cause: unknown) => {
    killProcessGroup(child, "SIGTERM");
    Deferred.doneUnsafe(done, Effect.succeed({ ok: false, cause }));
  });
  return Deferred.await(done);
}

const spawnCaptured = Effect.fnUntraced(function* (
  argv: readonly string[],
  opts: Pick<RunOptions, "cwd" | "env" | "input">,
): Effect.fn.Return<RunningProcess, ProcSpawnError> {
  const command = argv[0];
  if (command === undefined) {
    return yield* new ProcSpawnError({ argv, cause: new Error("empty argv") });
  }
  const child = yield* Effect.try({
    try: () =>
      spawn(command, argv.slice(1), {
        cwd: opts.cwd,
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: spawnEnv(opts.env),
        detached: true,
      }),
    catch: (cause) => new ProcSpawnError({ argv, cause }),
  });

  const life = watchChild(argv, child);
  const stdout = captureStream(child, child.stdout);
  const stderr = captureStream(child, child.stderr);
  const settled = Effect.map(
    Effect.all([stdout, stderr, life.exited], { concurrency: "unbounded" }),
    ([out, err, exitCode]): CapturedProcess => ({
      stdout: out,
      stderr: err,
      exitCode,
    }),
  );

  yield* life.started;
  return { child, settled };
});

function writeInput(
  argv: readonly string[],
  child: ChildProcess,
  input: string | undefined,
): Effect.Effect<void, ProcReadError> {
  const stdin = child.stdin;
  if (input === undefined || stdin === null) return Effect.void;
  return Effect.try({
    try: () => {
      stdin.on("error", () => {
        // A child that exits before reading its input fails the write with
        // EPIPE. That is the child's exit code to report, not a stdin error.
      });
      stdin.write(input);
      stdin.end();
    },
    catch: (cause) => new ProcReadError({ argv, stream: "stdin", cause }),
  });
}

const terminateCaptured = Effect.fnUntraced(function* (running: RunningProcess) {
  killProcessGroup(running.child, "SIGTERM");
  // `Effect.interruptible` so the grace timeout can actually cut the wait
  // short: this also runs as a finalizer, where the region is uninterruptible.
  const graceful = yield* Effect.interruptible(Effect.asVoid(running.settled)).pipe(
    Effect.timeoutOption(TERMINATION_GRACE_MS),
  );
  if (Option.isNone(graceful)) {
    killProcessGroup(running.child, "SIGKILL");
    yield* running.settled;
  }
});

function releaseCaptured(
  running: RunningProcess,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void> {
  // Kill first, then join every stream drain and the child itself, all before
  // the caller's semaphore permit is released.
  return exit._tag === "Success"
    ? Effect.asVoid(running.settled)
    : terminateCaptured(running);
}

const joinCaptured = Effect.fnUntraced(function* (
  argv: readonly string[],
  running: RunningProcess,
): Effect.fn.Return<CapturedProcess, ProcReadError> {
  const captured = yield* Effect.onInterrupt(running.settled, () =>
    terminateCaptured(running),
  );
  if (!captured.stdout.ok) {
    return yield* new ProcReadError({
      argv,
      stream: "stdout",
      cause: captured.stdout.cause,
    });
  }
  if (!captured.stderr.ok) {
    return yield* new ProcReadError({
      argv,
      stream: "stderr",
      cause: captured.stderr.cause,
    });
  }
  return captured;
});

/** Fails as soon as the external signal aborts, and never otherwise. */
function externalInterruption(
  argv: readonly string[],
  signal: AbortSignal,
): Effect.Effect<never, ProcInterruptedError> {
  return Effect.callback<never, ProcInterruptedError>((resume) => {
    const abort = () => {
      resume(Effect.fail(new ProcInterruptedError({ argv })));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

const capturedRun = Effect.fnUntraced(function* (
  argv: readonly string[],
  opts: RunOptions,
): Effect.fn.Return<
  RunResult,
  ProcSpawnError | ProcReadError | ProcInterruptedError,
  Scope.Scope
> {
  if (opts.signal?.aborted === true) {
    return yield* new ProcInterruptedError({ argv });
  }
  const running = yield* Effect.acquireRelease(
    spawnCaptured(argv, opts),
    releaseCaptured,
  );
  yield* writeInput(argv, running.child, opts.input);
  if (opts.signal !== undefined) {
    // After spawn an external abort preserves the caller's partial captured
    // output as a nonzero RunResult rather than failing the effect.
    yield* Effect.forkScoped(
      externalInterruption(argv, opts.signal).pipe(
        Effect.catch(() => terminateCaptured(running)),
      ),
    );
  }
  const timedOut = yield* Ref.make(false);
  const budget = opts.timeoutMs;
  if (budget !== undefined && budget > 0) {
    yield* Effect.forkScoped(
      Effect.interruptible(
        Effect.sleep(budget).pipe(
          Effect.andThen(Ref.set(timedOut, true)),
          Effect.andThen(
            Effect.sync(() => {
              killProcessGroup(running.child, "SIGKILL");
            }),
          ),
        ),
      ),
    );
  }
  const captured = yield* joinCaptured(argv, running);
  const didTimeOut = yield* Ref.get(timedOut);
  return {
    stdout: captured.stdout.ok ? captured.stdout.text : "",
    stderr: captured.stderr.ok ? captured.stderr.text : "",
    exitCode: captured.exitCode,
    timedOut: didTimeOut,
  };
}, Effect.scoped);

/**
 * Run a command and capture its output.
 *
 * `cwd` defaults to the current process's working directory. Waits for a
 * concurrency permit first, so a saturated program queues rather than forking
 * unboundedly. Interrupting the fiber kills the process group and joins it
 * before the effect finishes interrupting.
 */
export const run = Effect.fn("proc.run")(function* (
  argv: readonly string[],
  opts: RunOptions = {},
): Effect.fn.Return<RunResult, ProcSpawnError | ProcReadError | ProcInterruptedError> {
  const semaphore = yield* ProcConcurrency;
  const acquire =
    opts.signal === undefined
      ? semaphore.take(1)
      : Effect.raceFirst(semaphore.take(1), externalInterruption(argv, opts.signal));
  // The masked acquire/use/release shape of `Semaphore.withPermits`, racing
  // only the queued acquisition against the external signal. A cancelled take
  // leaves Effect's waiter set, and a successful take cannot be interrupted in
  // the gap before its release finalizer is installed.
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(acquire), (permits) =>
      Effect.ensuring(restore(capturedRun(argv, opts)), semaphore.release(permits)),
    ),
  );
});

/**
 * Run a command and return its trimmed stdout, failing with the precise
 * expected cause: `ProcTimeoutError` when the budget blew, and
 * `ProcNonZeroExitError` when the command itself failed.
 */
export function runOk(
  argv: readonly string[],
  opts: RunOptions = {},
): Effect.Effect<string, ProcError> {
  return run(argv, opts).pipe(
    Effect.flatMap(
      (result): Effect.Effect<string, ProcTimeoutError | ProcNonZeroExitError> => {
        if (result.timedOut) {
          return Effect.fail(
            new ProcTimeoutError({ argv, timeoutMs: opts.timeoutMs ?? 0, result }),
          );
        }
        if (result.exitCode !== 0) {
          return Effect.fail(new ProcNonZeroExitError({ argv, result }));
        }
        return Effect.succeed(result.stdout.trimEnd());
      },
    ),
  );
}

/** Whether the command exited zero. Output is captured and discarded. */
export function runQuiet(
  argv: readonly string[],
  opts: RunOptions = {},
): Effect.Effect<boolean, ProcSpawnError | ProcReadError | ProcInterruptedError> {
  return Effect.map(run(argv, opts), (result) => result.exitCode === 0);
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Make one line of subprocess output safe to log or render: strip ANSI escape
 * and OSC sequences, keep only the text after the last carriage return (so a
 * progress bar reports its final state), turn tabs into spaces, and drop the
 * remaining control bytes.
 */
export function sanitizeLine(line: string): string {
  let value = line.replace(ANSI_RE, "");
  const lastCr = value.lastIndexOf("\r");
  if (lastCr >= 0) value = value.slice(lastCr + 1);
  value = value.replace(/\t/g, " ");
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function drainLines(
  argv: readonly string[],
  stream: "stdout" | "stderr",
  readable: Readable | null,
  onLine: (line: string) => void,
): Effect.Effect<void, ProcReadError> {
  if (readable === null) return Effect.void;
  return Effect.callback<void, ProcReadError>((resume) => {
    const decoder = new TextDecoder();
    let buffer = "";
    let settled = false;
    const cleanup = () => {
      readable.off("data", onData);
      readable.off("end", onEnd);
      readable.off("error", onError);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.fail(new ProcReadError({ argv, stream, cause })));
    };
    /** Returns false when the callback threw and the drain is now failed. */
    const emit = (line: string): boolean => {
      try {
        onLine(sanitizeLine(line));
        return true;
      } catch (cause) {
        fail(cause);
        return false;
      }
    };
    const onData = (chunk: Uint8Array | string) => {
      if (settled) return;
      // A stream with an encoding set (or `Readable.from` over strings) emits
      // strings rather than bytes; both are legitimate inputs here.
      buffer +=
        typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!emit(line)) return;
        newline = buffer.indexOf("\n");
      }
    };
    const onEnd = () => {
      if (settled) return;
      const tail = buffer + decoder.decode();
      if (tail !== "" && !emit(tail)) return;
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: unknown) => {
      fail(cause);
    };
    readable.on("data", onData);
    readable.once("end", onEnd);
    readable.once("error", onError);
    return Effect.sync(() => {
      cleanup();
      readable.destroy();
    });
  });
}

/**
 * Drain a readable stream, calling `onLine` once per sanitized line and once
 * more for a trailing fragment without a newline. Interrupting the effect
 * removes the listeners and destroys the stream.
 */
export function streamLines(
  readable: Readable,
  onLine: (line: string) => void,
): Effect.Effect<void, ProcReadError> {
  return drainLines(["<stream>"], "stdout", readable, onLine);
}

interface StreamingProcess {
  readonly child: ChildProcess;
  readonly exited: Effect.Effect<number>;
}

const spawnStreaming = Effect.fnUntraced(function* (
  argv: readonly string[],
  opts: RunStreamingOptions,
): Effect.fn.Return<StreamingProcess, ProcSpawnError> {
  const command = argv[0];
  if (command === undefined) {
    return yield* new ProcSpawnError({ argv, cause: new Error("empty argv") });
  }
  const child = yield* Effect.try({
    try: () =>
      spawn(command, argv.slice(1), {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv(opts.env),
        detached: true,
      }),
    catch: (cause) => new ProcSpawnError({ argv, cause }),
  });
  const life = watchChild(argv, child);
  yield* life.started;
  return { child, exited: life.exited };
});

const terminateStreaming = Effect.fnUntraced(function* (proc: StreamingProcess) {
  killProcessGroup(proc.child, "SIGTERM");
  const graceful = yield* Effect.interruptible(Effect.asVoid(proc.exited)).pipe(
    Effect.timeoutOption(TERMINATION_GRACE_MS),
  );
  if (Option.isNone(graceful)) {
    killProcessGroup(proc.child, "SIGKILL");
    yield* proc.exited;
  }
});

function releaseStreaming(
  proc: StreamingProcess,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void> {
  return exit._tag === "Success"
    ? Effect.asVoid(proc.exited)
    : terminateStreaming(proc);
}

/**
 * Run a command, reporting stdout and stderr line by line as they arrive, and
 * resolve its exit code.
 *
 * `killAfterMs` is opt-in on purpose: an always-armed deadline would put a
 * ceiling on legitimately long commands like `pnpm install`. When it fires it
 * emits one more line, SIGKILLs the process group, and still joins fully, so a
 * hung teardown command cannot strand its caller.
 */
export const runStreaming = Effect.fn("proc.runStreaming")(function* (
  argv: readonly string[],
  opts: RunStreamingOptions = {},
): Effect.fn.Return<number, ProcSpawnError | ProcReadError, Scope.Scope> {
  const emit =
    opts.onLine ??
    (() => {
      // Discarding the output is a legitimate use: the exit code is the answer.
    });
  const proc = yield* Effect.acquireRelease(
    spawnStreaming(argv, opts),
    releaseStreaming,
  );
  const budget = opts.killAfterMs;
  if (budget !== undefined && budget > 0) {
    yield* Effect.forkScoped(
      Effect.interruptible(
        Effect.sleep(budget).pipe(
          Effect.andThen(
            Effect.sync(() => {
              emit(`timed out after ${Math.round(budget / 1000)}s, killing`);
              killProcessGroup(proc.child, "SIGKILL");
            }),
          ),
        ),
      ),
    );
  }
  const [exitCode] = yield* Effect.all(
    [
      proc.exited,
      drainLines(argv, "stdout", proc.child.stdout, emit),
      drainLines(argv, "stderr", proc.child.stderr, emit),
    ],
    { concurrency: "unbounded" },
  );
  return exitCode;
}, Effect.scoped);

/**
 * The part of a `ChildProcess` that `terminateSubprocess` needs. A real
 * `ChildProcess` satisfies it, and so does a test double.
 */
export interface TerminableProcess {
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): unknown;
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
}

/** Completes when the process has exited, immediately if it already has. */
function awaitExit(proc: TerminableProcess): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (proc.exitCode !== null) {
      resume(Effect.void);
      return;
    }
    const onExit = () => {
      resume(Effect.void);
    };
    proc.once("exit", onExit);
    return Effect.sync(() => {
      proc.removeListener("exit", onExit);
    });
  });
}

/**
 * Terminate a child this module did not spawn, typically one with inherited
 * stdio for an interactive handoff, without letting scope shutdown wait
 * forever: SIGTERM, a bounded grace period, SIGKILL, then a full join.
 *
 * Signals the process itself rather than its group, because an inherited-stdio
 * child usually shares the caller's process group.
 */
export const terminateSubprocess = Effect.fn("proc.terminateSubprocess")(function* (
  proc: TerminableProcess,
  graceMs = TERMINATION_GRACE_MS,
) {
  if (proc.exitCode !== null) return;
  const joined = awaitExit(proc);
  killSignal(proc, "SIGTERM");
  const graceful = yield* Effect.interruptible(joined).pipe(
    Effect.timeoutOption(graceMs),
  );
  if (Option.isSome(graceful)) return;
  killSignal(proc, "SIGKILL");
  yield* joined;
});

function killSignal(proc: TerminableProcess, signal: NodeJS.Signals): void {
  if (proc.exitCode !== null) return;
  try {
    proc.kill(signal);
  } catch {
    // The process may exit between the exitCode check and the kill.
  }
}
