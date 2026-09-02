import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  acquireLock,
  humanAge,
  LockError,
  type LockMeta,
  lockAge,
  lockLabel,
  lockStatus,
  readLockMeta,
  tryAcquireLock,
  withLock,
} from "./index.js";

const root = mkdtempSync(join(tmpdir(), "mitools-locks-"));
let counter = 0;
const lockPath = (name: string) => join(root, `${counter++}-${name}.lock`);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const STAMP = "2026-01-01T00:00:00.000Z";
/** Larger than any pid this machine will hand out, so it is never alive. */
const DEAD_PID = 2 ** 22 - 1;

/** Writes a lock file as another holder would have left it. */
function holdLock(path: string, meta: Partial<LockMeta> = {}): string {
  writeFileSync(
    path,
    JSON.stringify({
      op: "other",
      phase: "",
      pid: process.pid,
      host: hostname(),
      startedAt: STAMP,
      phaseStarted: STAMP,
      ...meta,
    }),
  );
  return path;
}

function expectSome<A>(option: Option.Option<A>): A {
  if (Option.isNone(option)) throw new Error("expected Some, got None");
  return option.value;
}

describe("tryAcquireLock", () => {
  it.effect("takes a free lock and releases it idempotently", () =>
    Effect.gen(function* () {
      const path = lockPath("free");
      const handle = expectSome(yield* tryAcquireLock(path, { op: "test" }));

      assert.strictEqual(handle.path, path);
      assert.isTrue(existsSync(path));
      const meta = yield* readLockMeta(path);
      assert.strictEqual(meta.op, "test");
      assert.strictEqual(meta.pid, process.pid);
      assert.strictEqual(meta.host, hostname());

      yield* handle.release;
      assert.isFalse(existsSync(path));
      yield* handle.release;
      assert.isFalse(existsSync(path));
    }),
  );

  it.effect("resolves None while a live process holds the lock", () =>
    Effect.gen(function* () {
      const path = lockPath("busy");
      const first = expectSome(yield* tryAcquireLock(path, { op: "first" }));

      assert.isTrue(Option.isNone(yield* tryAcquireLock(path, { op: "second" })));
      // The live holder's metadata is untouched by the failed attempt.
      assert.strictEqual((yield* readLockMeta(path)).op, "first");

      yield* first.release;
      const third = expectSome(yield* tryAcquireLock(path, { op: "third" }));
      assert.strictEqual((yield* readLockMeta(path)).op, "third");
      yield* third.release;
    }),
  );

  it.effect("reclaims a lock whose holder pid is dead", () =>
    Effect.gen(function* () {
      const path = holdLock(lockPath("dead-pid"), { op: "ghost", pid: DEAD_PID });

      const handle = expectSome(yield* tryAcquireLock(path, { op: "test" }));
      assert.strictEqual((yield* readLockMeta(path)).op, "test");
      yield* handle.release;
    }),
  );

  it.effect("reclaims a lock whose file has gone untouched for staleMs", () =>
    Effect.gen(function* () {
      const path = holdLock(lockPath("old-mtime"));
      // Real file mtimes are wall-clock, so put the test clock there too.
      const now = 1_800_000_000_000;
      yield* TestClock.setTime(now);
      const halfAnHourAgo = (now - 30 * 60_000) / 1000;
      utimesSync(path, halfAnHourAgo, halfAnHourAgo);

      const handle = expectSome(yield* tryAcquireLock(path, { op: "test" }));
      assert.strictEqual((yield* readLockMeta(path)).op, "test");
      yield* handle.release;
    }),
  );

  it.effect("keeps a fresh lock whose file holds no readable pid", () =>
    Effect.gen(function* () {
      const path = lockPath("garbage");
      writeFileSync(path, "not json at all");
      const now = 1_800_000_000_000;
      yield* TestClock.setTime(now);
      const recently = (now - 5_000) / 1000;
      utimesSync(path, recently, recently);

      assert.isTrue(Option.isNone(yield* tryAcquireLock(path, { op: "test" })));

      // Past the 60s bound that applies when the holder cannot be identified.
      const longAgo = (now - 120_000) / 1000;
      utimesSync(path, longAgo, longAgo);
      const handle = expectSome(yield* tryAcquireLock(path, { op: "test" }));
      yield* handle.release;
    }),
  );

  it.effect("releases the lock when the acquiring scope closes", () =>
    Effect.gen(function* () {
      const path = lockPath("scoped");
      yield* Effect.scoped(
        Effect.gen(function* () {
          assert.isTrue(Option.isSome(yield* tryAcquireLock(path, { op: "scoped" })));
          assert.isTrue(existsSync(path));
        }),
      );
      assert.isFalse(existsSync(path));
    }),
  );
});

describe("LockHandle.phase", () => {
  it.effect("rewrites the phase and its timestamp", () =>
    Effect.gen(function* () {
      const path = lockPath("phase");
      const handle = expectSome(
        yield* tryAcquireLock(path, { op: "update", phase: "fetch" }),
      );
      const before = yield* readLockMeta(path);
      assert.strictEqual(before.phase, "fetch");

      yield* TestClock.adjust("5 seconds");
      yield* handle.phase("install");

      const after = yield* readLockMeta(path);
      assert.strictEqual(after.op, "update");
      assert.strictEqual(after.phase, "install");
      assert.strictEqual(after.startedAt, before.startedAt);
      assert.notStrictEqual(after.phaseStarted, before.phaseStarted);
      assert.match(after.phaseStarted ?? "", /^\d{4}-\d{2}-\d{2}T/);

      yield* handle.release;
      // A released handle never resurrects its lock file.
      yield* handle.phase("too late");
      assert.isFalse(existsSync(path));
    }),
  );
});

describe("acquireLock", () => {
  it.effect("waits out a holder and takes the lock", () =>
    Effect.gen(function* () {
      const path = holdLock(lockPath("wait-scoped"));
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* acquireLock(path, {
              op: "waiter",
              timeoutMs: 10_000,
            });
            return (yield* readLockMeta(handle.path)).op;
          }),
        ),
      );

      yield* TestClock.adjust("10 millis");
      rmSync(path);
      yield* TestClock.adjust("1 second");

      assert.strictEqual(yield* Fiber.join(fiber), "waiter");
      assert.isFalse(existsSync(path));
    }),
  );
});

describe("withLock", () => {
  it.effect("runs the effect once the holder releases", () =>
    Effect.gen(function* () {
      const path = holdLock(lockPath("wait"));
      const fiber = yield* Effect.forkChild(
        withLock(path, Effect.succeed("done"), { op: "waiter", timeoutMs: 10_000 }),
      );

      yield* TestClock.adjust("10 millis");
      assert.isTrue(existsSync(path), "the holder still has it");
      rmSync(path);
      yield* TestClock.adjust("1 second");

      assert.strictEqual(yield* Fiber.join(fiber), "done");
      assert.isFalse(existsSync(path), "the lock is released afterwards");
    }),
  );

  it.effect("fails with operation 'wait' when the holder never lets go", () =>
    Effect.gen(function* () {
      const path = holdLock(lockPath("timeout"));
      const fiber = yield* Effect.forkChild(
        Effect.result(withLock(path, Effect.void, { op: "waiter", timeoutMs: 500 })),
      );

      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, LockError);
        assert.strictEqual(result.failure.operation, "wait");
        assert.strictEqual(result.failure.path, path);
        assert.strictEqual(
          result.failure.message,
          `timed out waiting for lock ${path}`,
        );
      }
      // The holder's lock file survived the failed wait.
      assert.strictEqual((yield* readLockMeta(path)).op, "other");
      rmSync(path);
    }),
  );

  it.effect("releases the lock when the holding fiber is interrupted", () =>
    Effect.gen(function* () {
      const path = lockPath("interrupt");
      const fiber = yield* Effect.forkChild(
        withLock(path, Effect.never, { op: "holder" }),
      );

      yield* TestClock.adjust("10 millis");
      assert.isTrue(existsSync(path));

      yield* Fiber.interrupt(fiber);
      assert.isFalse(existsSync(path));

      const handle = expectSome(yield* tryAcquireLock(path, { op: "next" }));
      yield* handle.release;
    }),
  );
});

describe("lockStatus", () => {
  it.effect("reports the metadata of a live holder", () =>
    Effect.gen(function* () {
      const path = lockPath("status");
      const handle = expectSome(
        yield* tryAcquireLock(path, { op: "merge", phase: "rebase" }),
      );

      const status = yield* lockStatus(path);
      assert.isTrue(Option.isSome(status));
      if (Option.isSome(status)) {
        assert.strictEqual(status.value.op, "merge");
        assert.strictEqual(status.value.phase, "rebase");
        assert.strictEqual(status.value.pid, process.pid);
        assert.strictEqual(lockLabel(status.value), "merge: rebase");
      }

      yield* handle.release;
      assert.isTrue(Option.isNone(yield* lockStatus(path)));
    }),
  );

  it.effect("reports None for a stale lock", () =>
    Effect.gen(function* () {
      const path = holdLock(lockPath("status-stale"), { pid: DEAD_PID });
      assert.isTrue(Option.isNone(yield* lockStatus(path)));
      rmSync(path);
    }),
  );

  it.effect("reports None when there is no lock file", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* lockStatus(lockPath("absent"))));
    }),
  );
});

describe("readLockMeta", () => {
  it.effect("resolves an empty object for missing, empty and invalid files", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readLockMeta(lockPath("nothing")), {});

      const empty = lockPath("empty");
      writeFileSync(empty, "   ");
      assert.deepStrictEqual(yield* readLockMeta(empty), {});

      const invalid = lockPath("invalid");
      writeFileSync(invalid, "[not json");
      assert.deepStrictEqual(yield* readLockMeta(invalid), {});

      const scalar = lockPath("scalar");
      writeFileSync(scalar, "42");
      assert.deepStrictEqual(yield* readLockMeta(scalar), {});
    }),
  );
});

describe("display helpers", () => {
  it("humanAge renders one coarse unit", () => {
    assert.strictEqual(humanAge(0), "0s");
    assert.strictEqual(humanAge(45.9), "45s");
    assert.strictEqual(humanAge(60), "1m");
    assert.strictEqual(humanAge(7200), "2h");
    assert.strictEqual(humanAge(86400 * 5), "5d");
  });

  it("lockAge measures from the current phase", () => {
    const meta = {
      startedAt: "1970-01-01T00:00:00.000Z",
      phaseStarted: "1970-01-01T00:01:00.000Z",
    };
    assert.strictEqual(lockAge(meta, 180_000), "2m");
    assert.strictEqual(lockAge({ startedAt: meta.startedAt }, 180_000), "3m");
    assert.isNull(lockAge({}, 180_000));
    assert.isNull(lockAge({ startedAt: "not a date" }, 180_000));
  });

  it("lockLabel falls back through phase, op and 'busy'", () => {
    assert.strictEqual(lockLabel({ op: "merge", phase: "rebase" }), "merge: rebase");
    assert.strictEqual(lockLabel({ op: "merge", phase: "merge" }), "merge");
    assert.strictEqual(lockLabel({ op: "merge" }), "merge");
    assert.strictEqual(lockLabel({ phase: "rebase" }), "rebase");
    assert.strictEqual(lockLabel({}), "busy");
  });
});
