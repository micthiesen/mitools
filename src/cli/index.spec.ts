import { assert, describe, it } from "@effect/vitest";
import { Cause, Data, Effect, Exit, Ref } from "effect";
import {
  exitCodeFor,
  type MainResult,
  type RunMainOptions,
  renderFailure,
  runMain,
} from "./index.js";

class BoomError extends Data.TaggedError("BoomError")<{
  readonly operation: string;
}> {
  override get message(): string {
    return `${this.operation}: boom`;
  }
}

/** The outcome of a `runMain` call: what it printed and the code it exited with. */
interface Outcome {
  readonly code: number;
  readonly errors: ReadonlyArray<string>;
}

/** Runs `runMain` with the process boundary injected, and resolves when it exits. */
const run = <E, EF = never>(
  program: Effect.Effect<MainResult, E, never>,
  options?: RunMainOptions<EF>,
): Effect.Effect<Outcome> =>
  Effect.callback<Outcome>((resume) => {
    const errors: Array<string> = [];
    runMain(program, {
      ...options,
      signals: false,
      stderr: (text) => errors.push(text),
      exit: (code) => resume(Effect.succeed({ code, errors })),
    });
  });

describe("renderFailure", () => {
  it("prints the message of a tagged failure", () => {
    const text = renderFailure(Cause.fail(new BoomError({ operation: "load config" })));
    assert.strictEqual(text, "load config: boom");
  });

  it("adds the stack to a tagged failure in debug mode", () => {
    const text = renderFailure(
      Cause.fail(new BoomError({ operation: "load config" })),
      {
        debug: true,
      },
    );
    assert.match(text, /^load config: boom\n/);
    assert.match(text, /BoomError/);
  });

  it("prints the stack of a defect", () => {
    const text = renderFailure(Cause.die(new Error("untyped throw")));
    assert.match(text, /Error: untyped throw/);
    assert.match(text, /at /);
  });

  it("stringifies a non-Error defect", () => {
    assert.strictEqual(renderFailure(Cause.die("just a string")), "just a string");
  });

  it("renders interruption as interrupted", () => {
    assert.strictEqual(renderFailure(Cause.interrupt()), "interrupted");
  });

  it("prints an untagged Error failure with its stack", () => {
    const text = renderFailure(Cause.fail(new Error("plain")));
    assert.match(text, /Error: plain/);
  });
});

describe("exitCodeFor", () => {
  it("uses a numeric result as the code", () => {
    assert.strictEqual(exitCodeFor(Exit.succeed(2)), 2);
  });

  it("maps a void result to 0", () => {
    assert.strictEqual(exitCodeFor(Exit.succeed(undefined)), 0);
  });

  it("maps a typed failure to 1", () => {
    assert.strictEqual(exitCodeFor(Exit.fail(new BoomError({ operation: "x" }))), 1);
  });

  it("maps a defect to 1", () => {
    assert.strictEqual(exitCodeFor(Exit.die(new Error("nope"))), 1);
  });

  it("maps interruption to 130", () => {
    assert.strictEqual(exitCodeFor(Exit.interrupt()), 130);
  });
});

describe("runMain", () => {
  it.live("exits 0 and prints nothing on success", () =>
    Effect.gen(function* () {
      const outcome = yield* run(Effect.void);
      assert.strictEqual(outcome.code, 0);
      assert.deepStrictEqual(outcome.errors, []);
    }),
  );

  it.live("uses a numeric result as the exit code", () =>
    Effect.gen(function* () {
      const outcome = yield* run(Effect.succeed(3));
      assert.strictEqual(outcome.code, 3);
    }),
  );

  it.live("prints a typed failure and exits 1", () =>
    Effect.gen(function* () {
      const outcome = yield* run(
        Effect.fail(new BoomError({ operation: "read config" })),
      );
      assert.strictEqual(outcome.code, 1);
      assert.deepStrictEqual(outcome.errors, ["read config: boom"]);
    }),
  );

  it.live("prints a defect with its stack and exits 1", () =>
    Effect.gen(function* () {
      const outcome = yield* run(Effect.die(new Error("untyped throw")));
      assert.strictEqual(outcome.code, 1);
      assert.match(outcome.errors[0] ?? "", /Error: untyped throw/);
    }),
  );

  it.live("adds the stack to a tagged failure when debug is set", () =>
    Effect.gen(function* () {
      const outcome = yield* run(Effect.fail(new BoomError({ operation: "read" })), {
        debug: true,
      });
      assert.match(outcome.errors[0] ?? "", /^read: boom\n/);
    }),
  );

  it.live("runs flush on success", () =>
    Effect.gen(function* () {
      const flushed = yield* Ref.make(0);
      const outcome = yield* run(Effect.succeed(0), {
        flush: Ref.update(flushed, (n) => n + 1),
      });
      assert.strictEqual(outcome.code, 0);
      assert.strictEqual(yield* Ref.get(flushed), 1);
    }),
  );

  it.live("runs flush on failure without changing the exit code", () =>
    Effect.gen(function* () {
      const flushed = yield* Ref.make(0);
      const outcome = yield* run(Effect.fail(new BoomError({ operation: "read" })), {
        flush: Ref.update(flushed, (n) => n + 1),
      });
      assert.strictEqual(outcome.code, 1);
      assert.strictEqual(yield* Ref.get(flushed), 1);
    }),
  );

  it.live("runs flush after a defect", () =>
    Effect.gen(function* () {
      const flushed = yield* Ref.make(0);
      const outcome = yield* run(Effect.die(new Error("nope")), {
        flush: Ref.update(flushed, (n) => n + 1),
      });
      assert.strictEqual(outcome.code, 1);
      assert.strictEqual(yield* Ref.get(flushed), 1);
    }),
  );

  it.live("exits 130 and prints nothing when the program is interrupted", () =>
    Effect.gen(function* () {
      const flushed = yield* Ref.make(0);
      const outcome = yield* run(Effect.interrupt, {
        flush: Ref.update(flushed, (n) => n + 1),
      });
      assert.strictEqual(outcome.code, 130);
      assert.deepStrictEqual(outcome.errors, []);
      assert.strictEqual(yield* Ref.get(flushed), 1);
    }),
  );

  it.live("swallows a failing flush", () =>
    Effect.gen(function* () {
      const outcome = yield* run(Effect.succeed(0), {
        flush: Effect.fail(new BoomError({ operation: "flush" })),
      });
      assert.strictEqual(outcome.code, 0);
      assert.deepStrictEqual(outcome.errors, []);
    }),
  );

  it.live("swallows a flush defect", () =>
    Effect.gen(function* () {
      const outcome = yield* run(Effect.succeed(0), {
        flush: Effect.die(new Error("flush blew up")),
      });
      assert.strictEqual(outcome.code, 0);
    }),
  );
});
