export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
}

export interface LoggerOptions {
  capture: boolean;
}

export interface LogItem {
  level: LogLevel;
  message: string;
  args: any[];
}
