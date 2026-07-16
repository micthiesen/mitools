import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSchema } from "../config/base.js";
import { Injector } from "../config/Injector.js";
import { Logger, type LogTapItem } from "./Logger.js";
import { LogLevel } from "./types.js";

describe("Logger.onLog tap", () => {
  beforeEach(() => {
    Injector.reset();
    Injector.configure({ config: baseConfigSchema.parse({ LOG_LEVEL: "info" }) });
  });

  afterEach(() => {
    Logger.onLog = null;
    Injector.reset();
    vi.restoreAllMocks();
  });

  it("receives sub-threshold DEBUG lines while console does not emit them", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const items: LogTapItem[] = [];
    Logger.onLog = (item) => items.push(item);

    new Logger("Test").debug("hidden line");

    expect(items).toHaveLength(1);
    expect(items[0].level).toBe(LogLevel.DEBUG);
    expect(items[0].message).toBe("hidden line");
    expect(items[0].timestamp).toBeTypeOf("number");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("receives the loggerName from an extended logger", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const items: LogTapItem[] = [];
    Logger.onLog = (item) => items.push(item);

    new Logger("Main").extend("LiveCheck").info("checking");

    expect(items).toHaveLength(1);
    expect(items[0].loggerName).toBe("Main:LiveCheck");
  });

  it("does not prevent the console write when the tap throws", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    Logger.onLog = () => {
      throw new Error("boom");
    };

    expect(() => new Logger("Test").info("still logs")).not.toThrow();
    expect(infoSpy).toHaveBeenCalledOnce();
  });

  it("passes formattedArgs as undefined with no args, joined/stringified with args", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const items: LogTapItem[] = [];
    Logger.onLog = (item) => items.push(item);
    const logger = new Logger("Test");

    logger.info("no args");
    logger.info("with args", "plain", { a: 1 }, 42);

    expect(items[0].formattedArgs).toBeUndefined();
    expect(items[1].formattedArgs).toBe('plain {"a":1} 42');
  });
});
