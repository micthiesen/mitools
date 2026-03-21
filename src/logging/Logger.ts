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
 * Notification payload passed to the onError hook.
 */
export interface ErrorNotification {
  /** The logger name (e.g. "Main:Scheduler") */
  loggerName: string;
  /** The error message */
  title: string;
  /** Formatted details from the extra args, or the message itself if no args */
  body: string;
}

/** Callback type for the error notification hook */
export type OnErrorHook = (notification: ErrorNotification) => void;

/**
 * Default onError hook: sends to Pushover if credentials are configured.
 * This preserves backwards compatibility for existing consumers.
 */
function defaultOnError(notification: ErrorNotification): void {
  notify({
    title: `Error: ${notification.title}`,
    message: notification.body,
  }).catch((err) => console.error("Failed to send Pushover notification:", err));
}

export class Logger {
  private options: LoggerOptions;
  private capturedLogs: LogItem[] = [];

  /**
   * Hook called on every .error() call, after the message is logged to console.
   * Override with Logger.onError = yourHandler to redirect error notifications
   * to Telegram, Slack, or any other channel.
   *
   * Set to null to disable error notifications entirely.
   */
  public static onError: OnErrorHook | null = defaultOnError;

  public constructor(
    public name: string,
    options?: Partial<LoggerOptions>,
  ) {
    this.options = { capture: options?.capture ?? false };
  }

  public extend(name: string | null, options?: Partial<LoggerOptions>): Logger {
    return new Logger(name ? `${this.name}:${name}` : this.name, options);
  }

  private static get logLevelNum() {
    return LOG_LEVEL_MAP[Injector.config.LOG_LEVEL];
  }

  public log(level: LogLevel, message: string, ...args: any[]) {
    const levelNum = LOG_LEVEL_MAP[level];
    if (levelNum < Logger.logLevelNum) return;
    const messageFinal = `${LOG_PREFIX_MAP[level]} <${this.name}> ${message}`;
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
  }

  public error(message: string, ...args: any[]) {
    this.log(LogLevel.ERROR, message, ...args);

    if (Logger.onError) {
      const body =
        args.length > 0
          ? args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
          : message;
      Logger.onError({ loggerName: this.name, title: message, body });
    }
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
