import { describe, expect, it, vi } from "vitest";
import { withRetry } from "./index.js";

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValueOnce("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after max attempts exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 }),
    ).rejects.toThrow("always fails");

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects shouldRetry predicate and stops early", async () => {
    const nonRetryable = new Error("fatal");
    const fn = vi.fn().mockRejectedValue(nonRetryable);

    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 1,
        shouldRetry: (err) => err !== nonRetryable,
      }),
    ).rejects.toThrow("fatal");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("tracks the correct number of attempts", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 4) throw new Error(`attempt ${attempts}`);
      return "done";
    });

    const result = await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(result).toBe("done");
    expect(attempts).toBe(4);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("logs warnings on retries when a logger is provided", async () => {
    const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");

    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      logger: logger as never,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Attempt 1/3 failed"),
      expect.any(Error),
    );
  });
});
