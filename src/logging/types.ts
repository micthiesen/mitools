import type { Effect } from "effect";

/**
 * Log levels, lowest to highest. The string values are stable: consumers
 * persist them (task-run logs) and compare them.
 */
export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
}

export const LOG_LEVEL_ORDINAL: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 10,
  [LogLevel.INFO]: 20,
  [LogLevel.WARN]: 30,
  [LogLevel.ERROR]: 40,
};

/** One log call, as seen by the sink, the tap and the capture layer. */
export interface LogItem {
  /** Epoch ms (from the runtime `Clock`) at the time of the log call. */
  readonly timestamp: number;
  readonly level: LogLevel;
  /** The logger name, e.g. "Main:Scheduler". */
  readonly loggerName: string;
  /** The raw message, no timestamp/prefix decoration. */
  readonly message: string;
  /** Extra args exactly as passed. */
  readonly args: ReadonlyArray<unknown>;
  /** Extra args joined to a string, undefined if no args. */
  readonly formattedArgs?: string;
}

/** Notification payload passed to the warn/error hooks. */
export interface LogNotification {
  readonly level: LogLevel;
  readonly loggerName: string;
  /** The log message. */
  readonly title: string;
  /** Formatted details from the extra args, or the message itself if no args. */
  readonly body: string;
}

/**
 * A warn/error hook. Runs in its own fiber; `Logger.flush` waits for every
 * hook fiber started so far. A hook must not fail: handle its own errors.
 */
export type LogHook<R = never> = (
  notification: LogNotification,
) => Effect.Effect<void, never, R>;

/**
 * A tap that sees EVERY log call regardless of the level threshold. Runs
 * inline before console output, so keep it cheap; a failing tap is reported
 * to the console and never breaks logging.
 */
export type LogTap<R = never> = (item: LogItem) => Effect.Effect<void, never, R>;

export function formatArgs(args: ReadonlyArray<unknown>): string {
  return args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
