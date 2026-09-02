import net from "node:net";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  isUnderPath,
  listeningProcesses,
  lsofScan,
  parseCwdMap,
  parseListeners,
  portInUse,
  probePort,
  processCwds,
} from "./index.js";

/** A real loopback listener on an ephemeral port, closed with the scope. */
const listener = Effect.acquireRelease(
  Effect.callback<net.Server>((resume) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => {
        resume(Effect.void);
      });
    }),
);

const portOf = (server: net.Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an ephemeral TCP address");
  }
  return address.port;
};

describe("parseListeners", () => {
  it.effect("groups field lines into one record per pid", () =>
    Effect.sync(() => {
      const parsed = parseListeners(
        [
          "p1234",
          "cnode",
          "n*:4199",
          "n127.0.0.1:8103",
          "p77",
          "cvite",
          "n[::1]:3000",
        ].join("\n"),
      );
      assert.deepStrictEqual(parsed, [
        { pid: 1234, command: "node", ports: [4199, 8103] },
        { pid: 77, command: "vite", ports: [3000] },
      ]);
    }),
  );

  it.effect("de-duplicates ports and ignores unparseable pids", () =>
    Effect.sync(() => {
      const parsed = parseListeners(
        ["pnope", "n*:1", "p0", "n*:2", "p9", "csrv", "n*:3", "n*:3"].join("\n"),
      );
      assert.deepStrictEqual(parsed, [{ pid: 9, command: "srv", ports: [3] }]);
    }),
  );

  it.effect("returns nothing for empty output", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(parseListeners(""), []);
    }),
  );
});

describe("parseCwdMap", () => {
  it.effect("maps each pid to its cwd", () =>
    Effect.sync(() => {
      const map = parseCwdMap(["p10", "n/tmp/one", "p20", "n/tmp/two"].join("\n"));
      assert.deepStrictEqual(
        [...map],
        [
          [10, "/tmp/one"],
          [20, "/tmp/two"],
        ],
      );
    }),
  );

  it.effect("skips name lines with no pid in scope", () =>
    Effect.sync(() => {
      const map = parseCwdMap(["n/tmp/orphan", "pbad", "n/tmp/also-orphan"].join("\n"));
      assert.strictEqual(map.size, 0);
    }),
  );
});

describe("isUnderPath", () => {
  it.effect("matches the root itself and paths beneath it", () =>
    Effect.sync(() => {
      assert.isTrue(isUnderPath("/wt/foo", "/wt/foo"));
      assert.isTrue(isUnderPath("/wt/foo/src", "/wt/foo"));
      assert.isTrue(isUnderPath("/wt/foo/src", "/wt/foo/"));
    }),
  );

  it.effect("never claims a sibling with a shared prefix", () =>
    Effect.sync(() => {
      assert.isFalse(isUnderPath("/wt/foobar", "/wt/foo"));
      assert.isFalse(isUnderPath("/wt", "/wt/foo"));
    }),
  );
});

describe("probePort", () => {
  it.live("reports listening for a real loopback server", () =>
    Effect.gen(function* () {
      const server = yield* listener;
      assert.strictEqual(yield* probePort(portOf(server)), "listening");
      assert.isTrue(yield* portInUse(portOf(server)));
    }),
  );

  it.live("reports free for a port nothing holds", () =>
    Effect.gen(function* () {
      const server = yield* listener;
      const port = portOf(server);
      yield* Effect.callback<void>((resume) => {
        server.close(() => {
          resume(Effect.void);
        });
      });
      assert.strictEqual(yield* probePort(port), "free");
      assert.isFalse(yield* portInUse(port));
    }),
  );
});

describe("lsofScan", () => {
  it.live("returns the output of a scan that finished", () =>
    Effect.gen(function* () {
      const scan = yield* lsofScan(["sh", "-c", "echo p1; echo cfoo; echo 'n*:4199'"], {
        timeoutMs: 5_000,
      });
      assert.isTrue(scan.complete);
      assert.deepStrictEqual(parseListeners(scan.out), [
        { pid: 1, command: "foo", ports: [4199] },
      ]);
    }),
  );

  it.live(
    "a twice-timed-out scan is incomplete, not an empty world",
    () =>
      Effect.gen(function* () {
        const scan = yield* lsofScan(["sleep", "5"], { timeoutMs: 100 });
        assert.isFalse(scan.complete);
        assert.strictEqual(scan.out, "");
        // The whole point: the empty output must not be read as "nothing
        // is listening", which is exactly what parsing it would say.
        assert.deepStrictEqual(parseListeners(scan.out), []);
      }),
    5_000,
  );

  it.live("a command that cannot run at all is incomplete too", () =>
    Effect.gen(function* () {
      const scan = yield* lsofScan(["mitools-definitely-not-a-command"], {
        timeoutMs: 1_000,
      });
      assert.isFalse(scan.complete);
      assert.strictEqual(scan.out, "");
    }),
  );
});

describe("listeningProcesses and processCwds", () => {
  it.live("None means unknown, never an empty answer", () =>
    Effect.gen(function* () {
      // A one-millisecond budget cannot finish a real lsof, so both attempts
      // blow it. The answer must be None, not an empty map.
      const cwds = yield* processCwds([1], { timeoutMs: 1 });
      assert.isTrue(Option.isNone(cwds));
    }),
  );

  it.live("processCwds short-circuits an empty pid list", () =>
    Effect.gen(function* () {
      const cwds = yield* processCwds([]);
      assert.isTrue(Option.isSome(cwds));
      assert.strictEqual(Option.getOrThrow(cwds).size, 0);
    }),
  );

  it.live(
    "listeningProcesses parses this machine's listeners when lsof finishes",
    () =>
      Effect.gen(function* () {
        const processes = yield* listeningProcesses({ timeoutMs: 2_000 });
        if (Option.isNone(processes)) return;
        for (const entry of Option.getOrThrow(processes)) {
          assert.isAbove(entry.pid, 0);
          for (const port of entry.ports) assert.isAbove(port, 0);
        }
      }),
    5_000,
  );
});
