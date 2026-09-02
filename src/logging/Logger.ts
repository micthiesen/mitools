import {
  Cause,
  Clock,
  Config,
  Console,
  Context,
  Effect,
  Logger as EffectLogger,
  type LogLevel as EffectLogLevel,
  FiberSet,
  Layer,
  Ref,
  References,
  type Scope,
} from "effect";
import {
  captureSink,
  consoleSink,
  type DailyFileSinkOptions,
  dailyFileSink,
  formatConsoleLine,
} from "./sinks.js";
import { layerTracer } from "./tracer.js";
import {
  formatArgs,
  LOG_LEVEL_ORDINAL,
  type LogHook,
  type LogItem,
  LogLevel,
  type LogNotification,
  type LogSink,
  type LogSinkInput,
  type LogTap,
} from "./types.js";

/** Annotation key the Effect logger adapter reads as the logger name. */
export const LOGGER_ANNOTATION = "logger";

/**
 * True inside a hook or tap fiber. A log call made from there (a tap that
 * persists lines through `Entity.upsert`, which itself logs) still prints and
 * is captured, but does not re-run the tap or hooks; without this guard every
 * such line would fork another hook fiber forever.
 */
export const InsideLogHook = Context.Reference<boolean>(
  "@micthiesen/mitools/InsideLogHook",
  {
    defaultValue: () => false,
  },
);

/**
 * A logger bound to a name. Pure to create (`Logger.named("Main")`); every
 * method is an `Effect` that requires the `Logger` service.
 */
export interface NamedLogger {
  readonly name: string;
  /** The channel every item from this logger carries, or undefined for the default channel. */
  readonly channelName: string | undefined;
  /** A child logger named `${name}:${child}` (or the same name when `null`), on the same channel. */
  extend(child: string | null): NamedLogger;
  /**
   * The same logger emitting on `channel` (see `LogItem.channel`): a sink
   * such as `channelSink(toast, "attention")` picks those lines out while
   * every other sink still records them. `null` returns to the default channel.
   */
  channel(channel: string | null): NamedLogger;
  log(
    level: LogLevel,
    message: string,
    ...args: unknown[]
  ): Effect.Effect<void, never, Logger>;
  debug(message: string, ...args: unknown[]): Effect.Effect<void, never, Logger>;
  info(message: string, ...args: unknown[]): Effect.Effect<void, never, Logger>;
  warn(message: string, ...args: unknown[]): Effect.Effect<void, never, Logger>;
  error(message: string, ...args: unknown[]): Effect.Effect<void, never, Logger>;
}

/** The service behind every `NamedLogger` and behind `Effect.log*` (via the adapter). */
export interface LoggerShape {
  /** Threshold below which items reach no sink; the tap still sees everything. */
  readonly level: LogLevel;
  /** Emits one log item: tap, threshold, sinks (in order), hooks. */
  emit(item: LogItem): Effect.Effect<void>;
  /**
   * `emit` for synchronous callers (Effect's own `Logger.log` contract). Runs
   * in a fiber tracked by `flush`; the synchronous part (console, capture)
   * completes before this returns unless the tap suspends. `insideHook` is the
   * caller's `InsideLogHook` value. After the layer's scope has closed the
   * item is written straight to the console instead of being dropped.
   */
  emitUnsafe(item: LogItem, insideHook?: boolean): void;
  /** Waits for every hook fiber started so far and for every sink's buffer. Run before process exit. */
  readonly flush: Effect.Effect<void>;
}

export interface LoggerOptions<R = never> {
  /** Sink threshold. Defaults to `LogLevel.INFO`. */
  readonly level?: LogLevel;
  /**
   * Where lines at or above `level` go, in order. Defaults to the console
   * (`Logger.consoleSink`); pass an explicit list to add or replace it, e.g.
   * `[Logger.consoleSink, Logger.dailyFileSink({ directory, prefix })]`.
   */
  readonly sinks?: ReadonlyArray<LogSinkInput<R>>;
  /** Called on every `error` log. Pair with `Pushover.logHook` to keep the old default. */
  readonly onError?: LogHook<R>;
  /** Called on every `warn` log. */
  readonly onWarn?: LogHook<R>;
  /** Sees every log call regardless of `level`. */
  readonly onLog?: LogTap<R>;
}

/** Every log item emitted through `Logger.layerCapture`, in order. */
export class CapturedLogs extends Context.Service<
  CapturedLogs,
  Ref.Ref<ReadonlyArray<LogItem>>
>()("@micthiesen/mitools/CapturedLogs") {}

/**
 * The logging service: hierarchical named loggers with a console threshold,
 * warn/error notification hooks with flush tracking, and a global tap.
 *
 * `Effect.log*` calls reach the same sink through `Logger.layerAdapter`.
 */
export class Logger extends Context.Service<Logger, LoggerShape>()(
  "@micthiesen/mitools/Logger",
) {
  /** A named logger. Pure; the effects it returns require `Logger`. */
  static named(name: string): NamedLogger {
    return makeNamed(name);
  }

  /** Waits for every pending hook fiber. Run before process exit or a Lambda return. */
  static readonly flush: Effect.Effect<void, never, Logger> = Logger.use(
    (l) => l.flush,
  );

  /** The given sinks (default: console) with the threshold, hooks and tap. */
  static layer<R = never>(
    options: LoggerOptions<R> = {},
  ): Layer.Layer<Logger, never, R> {
    return Layer.effect(Logger, makeService(options, options.sinks ?? [consoleSink]));
  }

  /**
   * `Logger.layer` with the threshold read from `LOG_LEVEL` (debug | info |
   * warn | error; default info) through the configured `ConfigProvider`.
   */
  static layerConfig<R = never>(
    options: Omit<LoggerOptions<R>, "level"> = {},
  ): Layer.Layer<Logger, Config.ConfigError, R> {
    return Layer.unwrap(
      Effect.map(
        Config.literals(
          [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR],
          "LOG_LEVEL",
        ).pipe(Config.withDefault(LogLevel.INFO)),
        (level) => Logger.layer({ ...options, level }),
      ),
    );
  }

  /**
   * Records items at or above `level` into `CapturedLogs` instead of printing
   * them (hooks, the tap and any extra `sinks` still run exactly as with
   * `layer`). For tests: read with `Logger.captured`.
   */
  static layerCapture<R = never>(
    options: LoggerOptions<R> = {},
  ): Layer.Layer<Logger | CapturedLogs, never, R> {
    return Layer.effect(
      Logger,
      Effect.gen(function* () {
        const captured = yield* CapturedLogs;
        return yield* makeService(options, [
          captureSink(captured),
          ...(options.sinks ?? []),
        ]);
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.effect(CapturedLogs, Ref.make<ReadonlyArray<LogItem>>([])),
      ),
    );
  }

  /** Every item captured so far by `Logger.layerCapture`. */
  static readonly captured: Effect.Effect<ReadonlyArray<LogItem>, never, CapturedLogs> =
    Effect.flatMap(CapturedLogs, Ref.get);

  /** Drops everything captured so far. */
  static readonly clearCaptured: Effect.Effect<void, never, CapturedLogs> =
    Effect.flatMap(CapturedLogs, (ref) => Ref.set(ref, []));

  /**
   * An Effect `Logger` that forwards `Effect.log*` into this service. The
   * logger name is taken from the `logger` log annotation (see
   * `Effect.annotateLogs`), falling back to "effect".
   */
  static readonly effectLogger: Effect.Effect<
    EffectLogger.Logger<unknown, void>,
    never,
    Logger
  > = Effect.map(Logger, (sink) =>
    EffectLogger.make<unknown, void>((options) => {
      sink.emitUnsafe(toLogItem(options), options.fiber.getRef(InsideLogHook));
    }),
  );

  /**
   * Routes `Effect.log*` into the `Logger` service and lifts Effect's own
   * minimum log level to `All` so the sink (and the tap) sees every call;
   * the sink applies the configured threshold to console output.
   */
  static readonly layerAdapter: Layer.Layer<never, never, Logger> = Layer.mergeAll(
    EffectLogger.layer([Logger.effectLogger]),
    Layer.succeed(References.MinimumLogLevel, "All"),
  );

  /** The default sink: the Effect `Console` service. */
  static readonly consoleSink: Effect.Effect<LogSink> = consoleSink;

  /** One file per local day with retention; see `dailyFileSink` in `./sinks`. */
  static dailyFileSink(
    options: DailyFileSinkOptions,
  ): Effect.Effect<LogSink, never, Scope.Scope> {
    return dailyFileSink(options);
  }

  /**
   * A `Tracer` that writes every ended `Effect.fn` / `Effect.withSpan` span
   * to this logger at debug: name, duration, parent and outcome. Provide it
   * alongside `layer`; nothing else consumes the span names otherwise.
   */
  static readonly layerTracer: Layer.Layer<never, never, Logger> = layerTracer;
}

function makeNamed(name: string, channelName?: string): NamedLogger {
  const log = (level: LogLevel, message: string, ...args: unknown[]) =>
    Effect.gen(function* () {
      const sink = yield* Logger;
      const timestamp = yield* Clock.currentTimeMillis;
      yield* sink.emit({
        timestamp,
        level,
        loggerName: name,
        message,
        args,
        formattedArgs: args.length > 0 ? formatArgs(args) : undefined,
        ...(channelName !== undefined && { channel: channelName }),
      });
    });
  return {
    name,
    channelName,
    extend: (child) => makeNamed(child ? `${name}:${child}` : name, channelName),
    channel: (channel) => makeNamed(name, channel ?? undefined),
    log,
    debug: (message, ...args) => log(LogLevel.DEBUG, message, ...args),
    info: (message, ...args) => log(LogLevel.INFO, message, ...args),
    warn: (message, ...args) => log(LogLevel.WARN, message, ...args),
    error: (message, ...args) => log(LogLevel.ERROR, message, ...args),
  };
}

function toNotification(item: LogItem): LogNotification {
  return {
    level: item.level,
    loggerName: item.loggerName,
    title: item.message,
    body: item.formattedArgs ?? item.message,
  };
}

const makeService = Effect.fnUntraced(function* <R>(
  options: LoggerOptions<R>,
  sinkInputs: ReadonlyArray<LogSinkInput<R>>,
) {
  const level = options.level ?? LogLevel.INFO;
  const threshold = LOG_LEVEL_ORDINAL[level];
  const hooks = yield* FiberSet.make<void, never>();
  const runHook = yield* FiberSet.runtime(hooks)<R>();
  const services = yield* Effect.context<R>();
  const console = yield* Console.Console;
  const sinks: Array<LogSink<R>> = [];
  for (const input of sinkInputs) {
    sinks.push(Effect.isEffect(input) ? yield* input : input);
  }

  const reportFailure = (what: string) => (cause: Cause.Cause<unknown>) =>
    Effect.sync(() => console.error(`Logger ${what} failed:`, Cause.pretty(cause)));

  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );

  const startHook = (what: string, hook: LogHook<R>, notification: LogNotification) =>
    Effect.sync(() => {
      runHook(
        hook(notification).pipe(
          Effect.provideService(InsideLogHook, true),
          Effect.catchCause(reportFailure(`${what} hook`)),
          Effect.provide(services),
        ),
      );
    });

  const emit = (item: LogItem): Effect.Effect<void> =>
    Effect.gen(function* () {
      const insideHook = yield* InsideLogHook;
      if (options.onLog && !insideHook) {
        yield* options
          .onLog(item)
          .pipe(
            Effect.provideService(InsideLogHook, true),
            Effect.catchCause(reportFailure("onLog hook")),
            Effect.provide(services),
          );
      }
      if (LOG_LEVEL_ORDINAL[item.level] >= threshold) {
        for (const sink of sinks) {
          yield* sink
            .write(item)
            .pipe(
              Effect.provideService(InsideLogHook, true),
              Effect.catchCause(reportFailure("sink")),
              Effect.provide(services),
            );
        }
      }
      if (insideHook) return;
      if (item.level === LogLevel.ERROR && options.onError) {
        yield* startHook("onError", options.onError, toNotification(item));
      } else if (item.level === LogLevel.WARN && options.onWarn) {
        yield* startHook("onWarn", options.onWarn, toNotification(item));
      }
    });

  const emitUnsafe = (item: LogItem, insideHook = false): void => {
    if (closed) {
      // The FiberSet is gone with the layer's scope; a line logged during
      // shutdown is exactly the one worth keeping, so print it directly.
      if (LOG_LEVEL_ORDINAL[item.level] >= threshold) {
        console[item.level](formatConsoleLine(item), ...item.args);
      }
      return;
    }
    runHook(Effect.provideService(emit(item), InsideLogHook, insideHook));
  };

  const flush = Effect.gen(function* () {
    yield* FiberSet.awaitEmpty(hooks);
    for (const sink of sinks) {
      if (sink.flush) yield* Effect.provide(sink.flush, services);
    }
  });

  return Logger.of({ level, emit, emitUnsafe, flush });
});

const EFFECT_LEVEL_MAP: Record<EffectLogLevel.LogLevel, LogLevel> = {
  All: LogLevel.DEBUG,
  Trace: LogLevel.DEBUG,
  Debug: LogLevel.DEBUG,
  Info: LogLevel.INFO,
  Warn: LogLevel.WARN,
  Error: LogLevel.ERROR,
  Fatal: LogLevel.ERROR,
  None: LogLevel.DEBUG,
};

function toLogItem(options: EffectLogger.Options<unknown>): LogItem {
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
  const { [LOGGER_ANNOTATION]: loggerName, ...rest } = annotations;
  const parts = Array.isArray(options.message) ? options.message : [options.message];
  const [first, ...others] = parts;
  const message = typeof first === "string" ? first : formatArgs([first]);
  const args: unknown[] = [...others];
  if (Object.keys(rest).length > 0) args.push(rest);
  if (options.cause.reasons.length > 0) args.push(Cause.pretty(options.cause));
  return {
    timestamp: options.date.getTime(),
    level: EFFECT_LEVEL_MAP[options.logLevel],
    loggerName: typeof loggerName === "string" ? loggerName : "effect",
    message,
    args,
    formattedArgs: args.length > 0 ? formatArgs(args) : undefined,
  };
}
