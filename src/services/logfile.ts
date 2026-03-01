import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../logging/Logger.js";
import type { LogLevel } from "../logging/types.js";

export class LogFile {
  private hasTruncated = false;

  constructor(
    private readonly filePath: string,
    private readonly mode: "overwrite" | "append",
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  section(heading: string, content: string): void {
    const flag = this.getWriteFlag();
    writeFileSync(this.filePath, `## ${heading}\n\n${content}\n\n`, { flag });
  }

  log(
    logger: Logger,
    level: LogLevel,
    heading: string,
    content: string,
    opts?: { consoleSummary?: string },
  ): void {
    this.section(heading, content);
    logger.log(level, opts?.consoleSummary ?? content);
  }

  private getWriteFlag(): string {
    if (this.mode === "append") return "a";
    if (!this.hasTruncated) {
      this.hasTruncated = true;
      return "w";
    }
    return "a";
  }

  static timestamped(directory: string): LogFile {
    mkdirSync(directory, { recursive: true });
    const ts = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d+Z$/, "");
    return new LogFile(`${directory}/${ts}.log`, "overwrite");
  }
}
