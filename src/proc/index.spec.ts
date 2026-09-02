import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Semaphore } from "effect";
import {
  ProcConcurrency,
  ProcInterruptedError,
  ProcNonZeroExitError,
  ProcSpawnError,
  ProcTimeoutError,
  run,
  runOk,
  runQuiet,
  runStreaming,
  sanitizeLine,
  streamLines,
  type TerminableProcess,
  terminateSubprocess,
} from "./index.js";

const root = mkdtempSync(join(tmpdir(), "mitools-proc-"));
let counter = 0;
const tempPath = (name: string) => join(root, `${counter++}-${name}`);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Poll a synchronous predicate on the real clock, up to three seconds. */
const waitUntil = (predicate: () => boolean, description: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (predicate()) return;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${description}`));
  });

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Occupies one permit for 30s, recording its pid so the test can watch it. */
const holder = (marker: string) =>
  run(["sh", "-c", 'echo $$ > "$MITOOLS_PROC_MARKER"; exec sleep 30'], {
    cwd: "/",
    env: { MITOOLS_PROC_MARKER: marker },
  });

/** Writes a marker the instant it gets a permit. */
const probe = (marker: string) =>
  run(["sh", "-c", 'echo spawned > "$MITOOLS_PROC_MARKER"'], {
    cwd: "/",
    env: { MITOOLS_PROC_MARKER: marker },
  });

const withPermits = (permits: number) =>
  Effect.provideService(ProcConcurrency, Semaphore.makeUnsafe(permits));

describe("run", () => {
  it.live("captures stdout, stderr and the exit code", () =>
    Effect.gen(function* () {
      const result = yield* run(["sh", "-c", "echo out; echo err >&2; exit 3"]);
      assert.strictEqual(result.stdout, "out\n");
      assert.strictEqual(result.stderr, "err\n");
      assert.strictEqual(result.exitCode, 3);
      assert.strictEqual(result.timedOut, false);
    }),
  );

  it.live("defaults cwd to the current process's working directory", () =>
    Effect.gen(function* () {
      const result = yield* run(["pwd"]);
      assert.strictEqual(result.stdout.trim(), process.cwd());
    }),
  );

  it.live("writes input to stdin and closes it", () =>
    Effect.gen(function* () {
      const result = yield* run(["cat"], { input: "piped\n" });
      assert.strictEqual(result.stdout, "piped\n");
      assert.strictEqual(result.exitCode, 0);
    }),
  );

  it.live("merges env over the parent environment", () =>
    Effect.gen(function* () {
      const result = yield* run(["sh", "-c", 'echo "$MITOOLS_PROC_VALUE"'], {
        env: { MITOOLS_PROC_VALUE: "set" },
      });
      assert.strictEqual(result.stdout.trim(), "set");
    }),
  );

  it.live("a spawn failure is a typed ProcSpawnError, not a defect", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run(["echo", "never-spawned"], { cwd: "/definitely/missing/mitools-proc" }),
      );
      assert.instanceOf(error, ProcSpawnError);
      assert.isAbove(error.message.length, 0);
    }),
  );

  it.live("an empty argv fails rather than spawning a shell", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run([]));
      assert.instanceOf(error, ProcSpawnError);
    }),
  );
});

describe("run timedOut", () => {
  it.live("a blown budget is flagged, and its empty stdout is not an answer", () =>
    Effect.gen(function* () {
      // Bare `sleep`, not `sh -c "sleep …; echo …"`: sh FORKS, so SIGKILLing
      // it leaves the child holding the inherited stdout pipe. `lsof`, the
      // real caller, does not fork, and buffers, so its stdout is empty here
      // for the same reason this one's is.
      const result = yield* run(["sleep", "5"], { cwd: "/", timeoutMs: 200 });
      assert.strictEqual(result.timedOut, true);
      assert.notStrictEqual(result.exitCode, 0);
      // The trap in one line: indistinguishable from a completed scan of an
      // empty world, which is what makes the flag load-bearing.
      assert.strictEqual(result.stdout, "");
    }),
  );

  it.live(
    "a timeout reaps background descendants holding captured pipes",
    () =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const result = yield* run(["sh", "-c", "sleep 30 &"], {
          cwd: "/",
          timeoutMs: 100,
        });
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        assert.isBelow(elapsed, 3_000);
        assert.strictEqual(result.timedOut, true);
      }),
    5_000,
  );

  it.live("a command that finishes inside its budget is not flagged", () =>
    Effect.gen(function* () {
      const result = yield* run(["echo", "hi"], { cwd: "/", timeoutMs: 30_000 });
      assert.strictEqual(result.timedOut, false);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "hi");
    }),
  );

  it.live("no budget at all leaves the flag off", () =>
    Effect.gen(function* () {
      const result = yield* run(["echo", "hi"], { cwd: "/" });
      assert.strictEqual(result.timedOut, false);
    }),
  );
});

describe("run external abort", () => {
  it.live("an already-aborted signal fails before spawning", () => {
    const controller = new AbortController();
    controller.abort();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        run(["sleep", "30"], { cwd: "/", signal: controller.signal }),
      );
      assert.instanceOf(error, ProcInterruptedError);
      assert.include(error.message, "aborted");
    });
  });

  it.live("a running external abort preserves captured output", () => {
    const marker = tempPath("external-abort");
    const controller = new AbortController();
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        run(
          [
            "sh",
            "-c",
            'echo started > "$MITOOLS_PROC_MARKER"; echo partial; exec sleep 30',
          ],
          {
            cwd: "/",
            env: { MITOOLS_PROC_MARKER: marker },
            signal: controller.signal,
          },
        ),
      );
      yield* waitUntil(() => existsSync(marker), "the abort target to spawn");
      controller.abort();
      const result = yield* Fiber.join(fiber);
      assert.notStrictEqual(result.exitCode, 0);
      assert.include(result.stdout, "partial");
    });
  });

  it.live(
    "a running external abort escalates when the process ignores SIGTERM",
    () => {
      const marker = tempPath("external-abort-term");
      const controller = new AbortController();
      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          run(
            [
              "sh",
              "-c",
              'trap "" TERM; echo started > "$MITOOLS_PROC_MARKER"; while :; do sleep 1; done',
            ],
            {
              cwd: "/",
              env: { MITOOLS_PROC_MARKER: marker },
              signal: controller.signal,
            },
          ),
        );
        yield* waitUntil(
          () => existsSync(marker),
          "the SIGTERM-resistant abort target",
        );
        const started = yield* Clock.currentTimeMillis;
        controller.abort();
        const result = yield* Fiber.join(fiber);
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        assert.isBelow(elapsed, 3_000);
        assert.notStrictEqual(result.exitCode, 0);
      });
    },
    5_000,
  );
});

describe("run interruption", () => {
  it.live(
    "removes a cancelled queued run before it can spawn",
    () =>
      Effect.gen(function* () {
        const markers = Array.from({ length: 8 }, (_, index) =>
          tempPath(`queued-holder-${index}`),
        );
        const holders = yield* Effect.forEach(
          markers,
          (marker) => Effect.forkScoped(holder(marker)),
          { concurrency: "unbounded" },
        );
        yield* waitUntil(
          () => markers.every(existsSync),
          "all semaphore permits to be occupied",
        );

        const queuedMarker = tempPath("queued-spawned");
        const queued = yield* Effect.forkChild(probe(queuedMarker));
        yield* Effect.sleep(30);
        yield* Fiber.interrupt(queued);

        // Freeing a permit is the decisive check. A stale waiter would now
        // acquire it and create the marker after its caller was cancelled.
        yield* Fiber.interrupt(holders[0]!);
        yield* Effect.sleep(100);
        assert.isFalse(existsSync(queuedMarker));
      }).pipe(withPermits(8)),
    5_000,
  );

  it.live(
    "kills and joins a running child before releasing its permit",
    () =>
      Effect.gen(function* () {
        const markers = Array.from({ length: 8 }, (_, index) =>
          tempPath(`running-holder-${index}`),
        );
        const holders = yield* Effect.forEach(
          markers,
          (marker) => Effect.forkScoped(holder(marker)),
          { concurrency: "unbounded" },
        );
        yield* waitUntil(
          () => markers.every(existsSync),
          "all semaphore permits to be occupied",
        );
        const interruptedPid = Number(readFileSync(markers[0]!, "utf8"));

        const probeMarker = tempPath("permit-reused");
        const reuse = yield* Effect.forkChild(probe(probeMarker));
        yield* Effect.sleep(30);
        assert.isFalse(existsSync(probeMarker));

        // Fiber.interrupt waits for the subprocess finalizer. On return the
        // child is gone and the queued probe can reuse the released permit.
        yield* Fiber.interrupt(holders[0]!);
        assert.isFalse(processIsAlive(interruptedPid));
        yield* Fiber.join(reuse);
        assert.isTrue(existsSync(probeMarker));
      }).pipe(withPermits(8)),
    5_000,
  );

  it.live(
    "escalates to SIGKILL when a child ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const marker = tempPath("ignores-term");
        const fiber = yield* Effect.forkChild(
          run(
            [
              "sh",
              "-c",
              'trap "" TERM; echo $$ > "$MITOOLS_PROC_MARKER"; while :; do sleep 1; done',
            ],
            { cwd: "/", env: { MITOOLS_PROC_MARKER: marker } },
          ),
        );
        yield* waitUntil(() => existsSync(marker), "the SIGTERM-resistant child");
        const pid = Number(readFileSync(marker, "utf8"));
        const started = yield* Clock.currentTimeMillis;
        yield* Fiber.interrupt(fiber);
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        assert.isBelow(elapsed, 3_000);
        assert.isFalse(processIsAlive(pid));
      }),
    5_000,
  );

  it.live(
    "ProcConcurrency is the seam: one permit serializes two runs",
    () =>
      Effect.gen(function* () {
        const first = tempPath("serial-first");
        const second = tempPath("serial-second");
        const held = yield* Effect.forkChild(
          run(["sh", "-c", 'echo $$ > "$MITOOLS_PROC_MARKER"; sleep 0.3'], {
            env: { MITOOLS_PROC_MARKER: first },
          }),
        );
        yield* waitUntil(() => existsSync(first), "the only permit to be taken");
        const queued = yield* Effect.forkChild(probe(second));
        yield* Effect.sleep(50);
        assert.isFalse(existsSync(second));
        yield* Fiber.join(held);
        yield* Fiber.join(queued);
        assert.isTrue(existsSync(second));
      }).pipe(withPermits(1)),
    5_000,
  );
});

describe("runOk and runQuiet", () => {
  it.live("runOk returns trimmed stdout", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* runOk(["echo", "value"]), "value");
    }),
  );

  it.live("runOk fails with ProcNonZeroExitError naming the command", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(runOk(["sh", "-c", "echo nope >&2; exit 2"]));
      assert.instanceOf(error, ProcNonZeroExitError);
      assert.include(error.message, "nope");
    }),
  );

  it.live("runOk fails with ProcTimeoutError when the budget blew", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runOk(["sleep", "5"], { cwd: "/", timeoutMs: 150 }),
      );
      assert.instanceOf(error, ProcTimeoutError);
      assert.include(error.message, "timed out after 150ms");
    }),
  );

  it.live("runQuiet reports only whether the command exited zero", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* runQuiet(["true"]));
      assert.isFalse(yield* runQuiet(["false"]));
    }),
  );
});

describe("runStreaming", () => {
  it.live(
    "kills a hung child and reports the timeout on the line stream",
    () =>
      Effect.gen(function* () {
        const lines: string[] = [];
        const started = yield* Clock.currentTimeMillis;
        const exitCode = yield* runStreaming(["sleep", "30"], {
          onLine: (line) => lines.push(line),
          killAfterMs: 300,
        });
        const elapsed = (yield* Clock.currentTimeMillis) - started;

        // The point is that it returns at all: a teardown command that hangs
        // must not strand whatever it was asked to tear down.
        assert.isBelow(elapsed, 3_000);
        assert.notStrictEqual(exitCode, 0);
        assert.include(lines.join("\n"), "timed out");
      }),
    5_000,
  );

  it.live("a child finishing inside the bound is untouched", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      const exitCode = yield* runStreaming(["echo", "done"], {
        onLine: (line) => lines.push(line),
        killAfterMs: 30_000,
      });
      assert.strictEqual(exitCode, 0);
      assert.include(lines, "done");
      assert.notInclude(lines.join("\n"), "timed out");
    }),
  );

  // Every caller that omits killAfterMs must keep the wait-forever behaviour:
  // the timer is opt-in, and an always-armed one would cap `pnpm install`.
  it.live("omitting killAfterMs leaves the child unbounded", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      const exitCode = yield* runStreaming(["sh", "-c", "sleep 0.4; echo slow"], {
        onLine: (line) => lines.push(line),
      });
      assert.strictEqual(exitCode, 0);
      assert.include(lines, "slow");
    }),
  );

  it.live(
    "killAfterMs reaps background descendants holding output pipes",
    () =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        yield* runStreaming(["sh", "-c", "sleep 30 &"], { killAfterMs: 100 });
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        assert.isBelow(elapsed, 3_000);
      }),
    5_000,
  );

  it.live("interleaves stdout and stderr lines", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      const exitCode = yield* runStreaming(
        ["sh", "-c", "echo one; echo two >&2; exit 7"],
        {
          onLine: (line) => lines.push(line),
        },
      );
      assert.strictEqual(exitCode, 7);
      assert.includeMembers(lines, ["one", "two"]);
    }),
  );

  it.live("a spawn failure is a typed ProcSpawnError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runStreaming(["echo", "hi"], { cwd: "/definitely/missing/mitools-proc" }),
      );
      assert.instanceOf(error, ProcSpawnError);
    }),
  );
});

describe("sanitizeLine", () => {
  it("strips ANSI colour sequences", () => {
    assert.strictEqual(sanitizeLine("\u001b[31mred\u001b[0m"), "red");
  });

  it("strips OSC sequences", () => {
    assert.strictEqual(sanitizeLine("\u001b]0;title\u0007text"), "text");
  });

  it("keeps only the text after the last carriage return", () => {
    assert.strictEqual(sanitizeLine("10%\r50%\r100%"), "100%");
  });

  it("turns tabs into spaces and drops other control bytes", () => {
    assert.strictEqual(sanitizeLine("a\tb\u0000c\u007f"), "a bc");
  });

  it("leaves ordinary text alone", () => {
    assert.strictEqual(sanitizeLine("plain text"), "plain text");
  });
});

describe("streamLines", () => {
  it.live("emits one sanitized line per newline plus the trailing fragment", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      yield* streamLines(
        Readable.from(["one\n\u001b[32mtw", "o\u001b[0m\ntail"]),
        (l) => lines.push(l),
      );
      assert.deepStrictEqual(lines, ["one", "two", "tail"]);
    }),
  );

  it.live("emits nothing for an empty stream", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      yield* streamLines(Readable.from([]), (l) => lines.push(l));
      assert.deepStrictEqual(lines, []);
    }),
  );
});

describe("terminateSubprocess", () => {
  interface FakeProcess {
    exitCode: number | null;
    readonly signals: NodeJS.Signals[];
    kill(signal?: NodeJS.Signals): void;
    once(event: "exit", listener: () => void): void;
    removeListener(event: "exit", listener: () => void): void;
  }

  /** A child that dies on `diesOn` and shrugs off everything before it. */
  const makeFake = (diesOn: NodeJS.Signals): FakeProcess => {
    const listeners = new Set<() => void>();
    const fake: FakeProcess = {
      exitCode: null,
      signals: [],
      kill(signal) {
        if (signal === undefined) return;
        fake.signals.push(signal);
        if (signal !== diesOn) return;
        fake.exitCode = signal === "SIGKILL" ? 137 : 143;
        for (const listener of listeners) listener();
      },
      once(_event, listener) {
        listeners.add(listener);
      },
      removeListener(_event, listener) {
        listeners.delete(listener);
      },
    };
    return fake;
  };

  it.live("escalates and joins a child that ignores SIGTERM", () =>
    Effect.gen(function* () {
      const fake = makeFake("SIGKILL");
      yield* terminateSubprocess(fake, 5);
      assert.deepStrictEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
      assert.strictEqual(fake.exitCode, 137);
    }),
  );

  it.live("stops at SIGTERM when the child exits inside the grace period", () =>
    Effect.gen(function* () {
      const fake = makeFake("SIGTERM");
      yield* terminateSubprocess(fake, 1_000);
      assert.deepStrictEqual(fake.signals, ["SIGTERM"]);
      assert.strictEqual(fake.exitCode, 143);
    }),
  );

  it.live("does nothing for a process that already exited", () =>
    Effect.gen(function* () {
      const fake = makeFake("SIGTERM");
      fake.exitCode = 0;
      const proc: TerminableProcess = fake;
      yield* terminateSubprocess(proc);
      assert.deepStrictEqual(fake.signals, []);
    }),
  );
});
