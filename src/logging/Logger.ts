import { Injector } from "../config/Injector.js";
import { notify } from "../services/pushover.js";
import { type LoggerOptions, type LogItem, LogLevel } from "./types.js";

const LOG_LEVEL_MAP: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 10,
  [LogLevel.INFO]: 20,
  [LogLevel.WARN]: 30,
  [LogLevel.ERROR]: 40,
};
const LOG_PREFIX_MAP: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "[DEBUG]",
  [LogLevel.INFO]: " [INFO]",
  [LogLevel.WARN]: " [WARN]",
  [LogLevel.ERROR]: "[ERROR]",
};

/**
 * Notification payload passed to log hooks.
 */
export interface LogNotification {
  /** The log level */
  level: LogLevel;
  /** The logger name (e.g. "Main:Scheduler") */
  loggerName: string;
  /** The log message */
  title: string;
  /** Formatted details from the extra args, or the message itself if no args */
  body: string;
}

/** @deprecated Use LogNotification instead */
export type ErrorNotification = LogNotification;

/** Callback type for log hooks. Return a promise to have it tracked by flush(). */
export type LogHook = (notification: LogNotification) => void | Promise<void>;

/** @deprecated Use LogHook instead */
export type OnErrorHook = LogHook;

/**
 * Default onError hook: sends to Pushover if credentials are configured.
 */
function defaultOnError(notification: LogNotification): void {
  notify({
    title: `Error: ${notification.title}`,
    message: notification.body,
  }).catch((err) => console.error("Failed to send Pushover notification:", err));
}

const pending = new Map<symbol, Promise<unknown>>();

function trackHook(hook: LogHook, notification: LogNotification): void {
  const result = hook(notification);
  if (result && typeof result.then === "function") {
    const id = Symbol();
    const tracked = result.finally(() => pending.delete(id));
    pending.set(id, tracked);
  }
}

export class Logger {
  private options: LoggerOptions;
  private capturedLogs: LogItem[] = [];

  /**
   * Hook called on every .error() call, after the message is logged to console.
   * Override with Logger.onError = yourHandler to redirect error notifications
   * to Telegram, Slack, or any other channel.
   *
   * If the hook returns a Promise, it is tracked and can be awaited via Logger.flush().
   * Set to null to disable error notifications entirely.
   */
  public static onError: LogHook | null = defaultOnError;

  /**
   * Optional hook called on every .warn() call.
   * If the hook returns a Promise, it is tracked and can be awaited via Logger.flush().
   */
  public static onWarn: LogHook | null = null;

  public constructor(
    public name: string,
    options?: Partial<LoggerOptions>,
  ) {
    this.options = { capture: options?.capture ?? false };
  }

  public extend(name: string | null, options?: Partial<LoggerOptions>): Logger {
    return new Logger(name ? `${this.name}:${name}` : this.name, options);
  }

  /**
   * Returns the configured log level threshold. Falls back to DEBUG (log
   * everything) if the Injector hasn't been configured yet, so Logger
   * can be used safely before loadConfig() runs.
   */
  private static get logLevelNum() {
    try {
      return LOG_LEVEL_MAP[Injector.config.LOG_LEVEL];
    } catch {
      return LOG_LEVEL_MAP[LogLevel.DEBUG];
    }
  }

  public log(level: LogLevel, message: string, ...args: any[]) {
    const levelNum = LOG_LEVEL_MAP[level];
    if (levelNum < Logger.logLevelNum) return;
    const timestamp = new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
    const messageFinal = `${timestamp} ${LOG_PREFIX_MAP[level]} <${this.name}> ${message}`;
    console[level](messageFinal, ...args);
    if (this.options.capture) this.capturedLogs.push({ level, message, args });
  }

  public debug(message: string, ...args: any[]) {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  public info(message: string, ...args: any[]) {
    this.log(LogLevel.INFO, message, ...args);
  }

  public warn(message: string, ...args: any[]) {
    this.log(LogLevel.WARN, message, ...args);

    if (Logger.onWarn) {
      trackHook(Logger.onWarn, this.buildNotification(LogLevel.WARN, message, args));
    }
  }

  public error(message: string, ...args: any[]) {
    this.log(LogLevel.ERROR, message, ...args);

    if (Logger.onError) {
      trackHook(Logger.onError, this.buildNotification(LogLevel.ERROR, message, args));
    }
  }

  private buildNotification(
    level: LogLevel,
    message: string,
    args: any[],
  ): LogNotification {
    const body =
      args.length > 0
        ? args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
        : message;
    return { level, loggerName: this.name, title: message, body };
  }

  /** Await all pending hook promises (notifications, etc.). Call before process exit or Lambda return. */
  public static async flush(): Promise<void> {
    await Promise.all(pending.values());
    pending.clear();
  }

  public getCapturedLogs(): LogItem[] {
    if (!this.options.capture)
      throw new Error("Cannot get logs when capture is disabled");
    return this.capturedLogs;
  }

  public clearCapturedLogs() {
    if (!this.options.capture)
      throw new Error("Cannot clear logs when capture is disabled");
    this.capturedLogs = [];
  }
}
