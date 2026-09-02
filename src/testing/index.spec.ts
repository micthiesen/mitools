import { existsSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { Clock, Context, Data, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  runWithVirtualTime,
  testRuntime,
  tmpDir,
  trackedTmpDirs,
  withVirtualTime,
} from "./index.js";

class Greeter extends Context.Service<
  Greeter,
  { readonly greet: (name: string) => string }
>()("test/Greeter") {}

const GreeterLayer = Layer.succeed(Greeter)({
  greet: (name: string) => `hello ${name}`,
});

class NopeError extends Data.TaggedError("NopeError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `nope: ${this.detail}`;
  }
}

const { tmp } = trackedTmpDirs();

describe("withVirtualTime", () => {
  it.effect("completes a sleeping effect without wall time", () =>
    Effect.gen(function* () {
      const result = yield* withVirtualTime(
        Effect.as(Effect.sleep("10 seconds"), "slept"),
        "10 seconds",
      );
      assert.strictEqual(result, "slept");
    }),
  );

  it.effect("propagates the effect's typed failure", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        withVirtualTime(Effect.fail("nope" as const), "1 second"),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});

describe("runWithVirtualTime", () => {
  it.live("completes a ten second sleep in well under a second of wall time", () =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const result = yield* Effect.promise(() =>
        runWithVirtualTime(
          Effect.as(Effect.sleep("10 seconds"), "slept"),
          "10 seconds",
        ),
      );
      assert.strictEqual(result, "slept");
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 1000);
    }),
  );

  it.live("rejects when the effect fails", () =>
    Effect.gen(function* () {
      const settled = yield* Effect.promise(() =>
        runWithVirtualTime(new NopeError({ detail: "failed" }), "1 second").then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
      );
      assert.strictEqual(settled, "rejected");
    }),
  );
});

describe("trackedTmpDirs", () => {
  it.live("creates a fresh directory per call", () =>
    Effect.sync(() => {
      const first = tmp("mitools-tracked-");
      const second = tmp("mitools-tracked-");
      assert.notStrictEqual(first, second);
      assert.isTrue(existsSync(first));
      assert.isTrue(existsSync(second));
    }),
  );
});

describe("tmpDir", () => {
  it.live("removes the directory when the scope closes", () =>
    Effect.gen(function* () {
      let dir = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          dir = yield* tmpDir("mitools-scoped-");
          assert.isTrue(existsSync(dir));
        }),
      );
      assert.isFalse(existsSync(dir));
    }),
  );

  it.live("removes the directory when the fiber is interrupted", () =>
    Effect.gen(function* () {
      let dir = "";
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            dir = yield* tmpDir("mitools-interrupt-");
            return yield* Effect.interrupt;
          }),
        ),
      );
      assert.isTrue(exit._tag === "Failure");
      assert.isFalse(existsSync(dir));
    }),
  );
});

describe("testRuntime", () => {
  it.effect("runs effects that need the layer's services", () =>
    Effect.gen(function* () {
      const runner = yield* testRuntime(GreeterLayer);
      const greeting = yield* Effect.promise(() =>
        runner.runPromise(Effect.map(Greeter, (g) => g.greet("mitools"))),
      );
      assert.strictEqual(greeting, "hello mitools");
    }),
  );

  it.effect("carries a TestClock into the runner, so time stays virtual", () =>
    Effect.gen(function* () {
      const runner = yield* testRuntime(TestClock.layer());
      const now = yield* Effect.promise(() =>
        runner.runPromise(Clock.currentTimeMillis),
      );
      assert.strictEqual(now, 0);
    }),
  );

  it.effect("fails with the layer's error instead of deferring it to a run", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        testRuntime(Layer.effect(Greeter)(Effect.fail("bad config" as const))),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});
