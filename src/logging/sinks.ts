import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Console, Deferred, Effect, Queue, Ref, type Scope } from "effect";
import { operationErrors } from "../errors/index.js";
import { LOG_LEVEL_ORDINAL, type LogItem, LogLevel, type LogSink } from "./types.js";

const LOG_PREFIX: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "[DEBUG]",
  [LogLevel.INFO]: " [INFO]",
  [LogLevel.WARN]: " [WARN]",
  [LogLevel.ERROR]: "[ERROR]",
};

/** The console line: `HH:mm:ss.mmm [LEVEL] <name> message`. */
export function formatConsoleLine(item: LogItem): string {
  const time = new Date(item.timestamp).toISOString().slice(11, 23);
  const channel = item.channel ? ` (${item.channel})` : "";
  return `${time} ${LOG_PREFIX[item.level]} <${item.loggerName}>${channel} ${item.message}`;
}

/** Writes each item to the Effect `Console` service (stdout for debug/info, stderr for warn/error). */
export const consoleSink: Effect.Effect<LogSink> = Effect.map(
  Console.Console,
  (console) => ({
    write: (item) =>
      Effect.sync(() => console[item.level](formatConsoleLine(item), ...item.args)),
  }),
);

/** Appends each item to `ref`; what `Logger.layerCapture` records. */
export function captureSink(ref: Ref.Ref<ReadonlyArray<LogItem>>): LogSink {
  return { write: (item) => Ref.update(ref, (items) => [...items, item]) };
}

/**
 * A sink that only forwards items at or above `level` (on top of the
 * logger's own threshold). For a noisy channel feeding a quiet display.
 */
export function filterSink<R>(
  sink: LogSink<R>,
  predicate: (item: LogItem) => boolean,
): LogSink<R> {
  return {
    write: (item) => (predicate(item) ? sink.write(item) : Effect.void),
    ...(sink.flush ? { flush: sink.flush } : {}),
  };
}

/** `filterSink` by channel: the shape of a toast sink over an "attention" channel. */
export function channelSink<R>(sink: LogSink<R>, channel: string): LogSink<R> {
  return filterSink(sink, (item) => item.channel === channel);
}

/** `filterSink` by minimum level. */
export function levelSink<R>(sink: LogSink<R>, level: LogLevel): LogSink<R> {
  const threshold = LOG_LEVEL_ORDINAL[level];
  return filterSink(sink, (item) => LOG_LEVEL_ORDINAL[item.level] >= threshold);
}

export interface DailyFileSinkOptions {
  /** Directory of the log files; created on the first write. */
  readonly directory: string;
  /** File name prefix: `<directory>/<prefix>-YYYY-MM-DD.log`. */
  readonly prefix: string;
  /** Files matching the prefix older than this are unlinked on the first write. Default 14; 0 disables. */
  readonly retainDays?: number;
  /** Line format; defaults to `formatFileLine`. Must end without a newline. */
  readonly format?: (item: LogItem) => string;
}

const LEVEL_PAD = 5;
const NAME_PAD = 16;

/**
 * Replaces control bytes so the file stays grep-able text: one NUL flips
 * BSD grep into binary mode over the whole file. Tabs and newlines pass.
 */
export function sanitizeControl(text: string): string {
  return text.replace(/[\0-\x08\x0B-\x1F\x7F]/g, "�");
}

/**
 * The file line: `<ISO timestamp> <LEVEL> [<channel>] <name> <message> <args>`.
 * Continuation lines are indented so a multi-line message (a stack trace)
 * stays readable under `tail -F` without swallowing the next record's
 * timestamp.
 */
export function formatFileLine(item: LogItem): string {
  const level = item.level.toUpperCase().padEnd(LEVEL_PAD);
  const channel = item.channel ? `${item.channel} ` : "";
  const text = sanitizeControl(
    item.formattedArgs === undefined
      ? item.message
      : `${item.message} ${item.formattedArgs}`,
  );
  const body = text.includes("\n") ? text.replaceAll("\n", "\n        ") : text;
  return `${new Date(item.timestamp).toISOString()} ${level} ${channel}${item.loggerName.padEnd(NAME_PAD)} ${body}`;
}

/** Local calendar date (the user's "today") of an epoch-ms timestamp. */
function localDate(timestamp: number): string {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type FileCommand =
  | { readonly _tag: "Write"; readonly path: string; readonly line: string }
  | { readonly _tag: "Flush"; readonly done: Deferred.Deferred<void> };

const io = operationErrors("logging");

/**
 * One file per local day (`<prefix>-YYYY-MM-DD.log`), appended through a
 * single writer fiber so lines land in order, with retention by mtime on
 * the first write. Every write is one `appendFile` (O_APPEND), so several
 * processes can share the file without coordination. A write failure is
 * reported to the console once per path and never propagates; `flush`
 * waits for every queued line, and the sink's scope flushes before it
 * closes.
 */
export const dailyFileSink = Effect.fn("Logger.dailyFileSink")(function* (
  options: DailyFileSinkOptions,
): Effect.fn.Return<LogSink, never, Scope.Scope> {
  const format = options.format ?? formatFileLine;
  const retainDays = options.retainDays ?? 14;
  const console = yield* Console.Console;
  const queue = yield* Queue.unbounded<FileCommand>();
  const reported = new Set<string>();
  let initialized = false;

  const report = (what: string) => (cause: unknown) =>
    Effect.sync(() => {
      if (reported.has(what)) return;
      reported.add(what);
      console.error(`Logger file sink: ${what}:`, cause);
    });

  const init = Effect.gen(function* () {
    if (initialized) return;
    initialized = true;
    const made = yield* io
      .promise(`mkdir ${options.directory}`, () =>
        mkdir(options.directory, { recursive: true }),
      )
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.as(report(`mkdir ${options.directory}`)(cause), false),
        ),
      );
    if (made && retainDays > 0) yield* sweepOld;
  });

  const sweepOld = Effect.gen(function* () {
    const cutoff = (yield* Clock.currentTimeMillis) - retainDays * 24 * 60 * 60 * 1000;
    const names = yield* io.promise(`readdir ${options.directory}`, () =>
      readdir(options.directory),
    );
    for (const name of names) {
      if (!name.startsWith(`${options.prefix}-`) || !name.endsWith(".log")) continue;
      const path = join(options.directory, name);
      yield* io
        .promise(`stat ${path}`, () => stat(path))
        .pipe(
          Effect.flatMap((s) =>
            s.mtimeMs < cutoff
              ? io.promise(`unlink ${path}`, () => unlink(path))
              : Effect.void,
          ),
          Effect.ignore,
        );
    }
  }).pipe(Effect.catch(report(`sweep ${options.directory}`)));

  const handle = (command: FileCommand) => {
    if (command._tag === "Flush") return Deferred.succeed(command.done, undefined);
    return init.pipe(
      Effect.andThen(
        io.promise(`append ${command.path}`, () =>
          appendFile(command.path, `${command.line}\n`, "utf8"),
        ),
      ),
      Effect.catch(report(`append ${command.path}`)),
    );
  };

  yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(queue), handle)));

  const flush = Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    yield* Queue.offer(queue, { _tag: "Flush", done });
    yield* Deferred.await(done);
  });
  // Registered after the writer fork so it runs before the writer is interrupted.
  yield* Effect.addFinalizer(() => flush);

  return {
    write: (item) =>
      Effect.asVoid(
        Queue.offer(queue, {
          _tag: "Write",
          path: join(
            options.directory,
            `${options.prefix}-${localDate(item.timestamp)}.log`,
          ),
          line: format(item),
        }),
      ),
    flush,
  };
});
