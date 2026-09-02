import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DateTime, Effect, Semaphore } from "effect";
import { type OperationError, operationErrors } from "../errors/index.js";
import type { Logger, NamedLogger } from "../logging/Logger.js";
import type { LogLevel } from "../logging/types.js";

const io = operationErrors("logfile");

/**
 * A markdown-ish log file written in `## heading` sections. Writes are
 * serialized, so concurrent sections never interleave.
 */
export class LogFile {
  private constructor(
    public readonly filePath: string,
    private readonly mode: "overwrite" | "append",
    private readonly lock: Semaphore.Semaphore,
    private hasTruncated: boolean,
  ) {}

  /** Creates the parent directory and resolves a handle; nothing is written yet. */
  static make(
    filePath: string,
    mode: "overwrite" | "append",
  ): Effect.Effect<LogFile, OperationError> {
    return Effect.gen(function* () {
      yield* io.promise(`mkdir ${dirname(filePath)}`, () =>
        mkdir(dirname(filePath), { recursive: true }),
      );
      const lock = yield* Semaphore.make(1);
      return new LogFile(filePath, mode, lock, false);
    });
  }

  /** `<directory>/<ISO timestamp>.log` in overwrite mode, timestamped from the runtime clock. */
  static timestamped(directory: string): Effect.Effect<LogFile, OperationError> {
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const ts = DateTime.formatIso(now)
        .replace(/:/g, "-")
        .replace(/\.\d+Z$/, "");
      return yield* LogFile.make(`${directory}/${ts}.log`, "overwrite");
    });
  }

  /** Appends one `## heading` section (the first write truncates in overwrite mode). */
  section(heading: string, content: string): Effect.Effect<void, OperationError> {
    return Semaphore.withPermits(
      this.lock,
      1,
    )(
      Effect.suspend(() => {
        const flag = this.nextWriteFlag();
        return io.promise(`write ${this.filePath}`, (signal) =>
          writeFile(this.filePath, `## ${heading}\n\n${content}\n\n`, { flag, signal }),
        );
      }),
    );
  }

  /** Writes a section and logs `consoleSummary` (or the content) through `logger`. */
  log(
    logger: NamedLogger,
    level: LogLevel,
    heading: string,
    content: string,
    opts?: { consoleSummary?: string },
  ): Effect.Effect<void, OperationError, Logger> {
    return this.section(heading, content).pipe(
      Effect.andThen(logger.log(level, opts?.consoleSummary ?? content)),
    );
  }

  private nextWriteFlag(): "a" | "w" {
    if (this.mode === "append") return "a";
    if (!this.hasTruncated) {
      this.hasTruncated = true;
      return "w";
    }
    return "a";
  }
}
