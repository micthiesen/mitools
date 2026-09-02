/**
 * Three-valued probes for "is something listening?" and "what is listening?".
 *
 * The shared rule: a probe that ran out of time reports `unknown`, never
 * "free" or "nothing found". Both probes here have a failure mode where the
 * inconclusive answer is byte-identical to the empty answer, and reading one
 * as the other is expensive in exactly one direction.
 *
 * - A loopback connect that times out says nothing about the port and
 *   everything about our own event loop, so `probePort` never reports `free`
 *   for it.
 * - An `lsof` scan that blows its budget is SIGKILLed mid-run, and `lsof`
 *   buffers, so the result is zero bytes with a nonzero exit: an empty
 *   listener list that reads exactly like "nothing is listening".
 */
import net from "node:net";
import { Data, Effect, Option, Schedule } from "effect";
import { type ProcError, run } from "../proc/index.js";

/**
 * Outcome of a loopback port probe. `unknown` is a real third answer, not a
 * synonym for `free`.
 */
export type PortProbe = "listening" | "free" | "unknown";

const PROBE_TIMEOUT_MS = 400;

/**
 * One loopback connect attempt. `ECONNREFUSED` is the only definitive
 * "nothing is listening": on loopback a live server accepts and a dead one
 * refuses, both essentially instantly, so a timeout says nothing about the
 * port.
 *
 * Specifically, the deadline is a timer on OUR event loop, and libuv runs the
 * timers phase before the poll phase. Block the loop past `timeoutMs` (a heavy
 * render, a big synchronous parse) and the timeout callback fires ahead of a
 * `connect` event that already landed, so the probe would report "free" for a
 * port that is demonstrably listening. Hence `unknown`, never `free`.
 */
function probePortOnce(port: number, timeoutMs: number): Effect.Effect<PortProbe> {
  return Effect.callback<PortProbe>((resume) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (result: PortProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(result));
    };
    socket.setTimeout(timeoutMs, () => {
      done("unknown");
    });
    socket.once("connect", () => {
      done("listening");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      done(error.code === "ECONNREFUSED" ? "free" : "unknown");
    });
    return Effect.sync(() => {
      socket.removeAllListeners();
      socket.destroy();
    });
  });
}

/**
 * Whether something accepts TCP connections on the port. Loopback only: a
 * server may bind wider, but loopback is always reachable when it is up.
 *
 * An inconclusive first attempt is retried once, because the usual cause is
 * our own loop having been blocked past the deadline and by now it is running
 * again. Only a twice-inconclusive probe reports `unknown`.
 */
export const probePort = Effect.fn("probes.probePort")(function* (
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Effect.fn.Return<PortProbe> {
  const first = yield* probePortOnce(port, timeoutMs);
  if (first !== "unknown") return first;
  return yield* probePortOnce(port, timeoutMs);
});

/**
 * Port-allocation view of the probe: anything but a definitive `free` counts
 * as taken. Handing out a port we merely failed to read would collide with
 * whatever is actually on it.
 */
export function portInUse(port: number): Effect.Effect<boolean> {
  return Effect.map(probePort(port), (result) => result !== "free");
}

/** One process holding at least one listening TCP socket. */
export interface ListeningProcess {
  readonly pid: number;
  readonly command: string;
  /** Every port it was seen listening on. */
  readonly ports: readonly number[];
}

/**
 * Parse `lsof -Fpcn` LISTEN output into one record per pid. Field lines:
 * `p<pid>` starts a process, `c<command>` names it, and `n<addr>` is one
 * listening socket (`*:4199`, `127.0.0.1:8103`, `[::1]:3000`).
 */
export function parseListeners(out: string): ListeningProcess[] {
  const byPid = new Map<number, { pid: number; command: string; ports: number[] }>();
  let current: { pid: number; command: string; ports: number[] } | null = null;
  for (const line of out.split("\n")) {
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") {
      const pid = Number(rest);
      if (!Number.isInteger(pid) || pid <= 0) {
        current = null;
        continue;
      }
      current = byPid.get(pid) ?? { pid, command: "", ports: [] };
      byPid.set(pid, current);
    } else if (tag === "c" && current !== null) {
      current.command = rest;
    } else if (tag === "n" && current !== null) {
      const port = Number(rest.slice(rest.lastIndexOf(":") + 1));
      if (Number.isInteger(port) && port > 0 && !current.ports.includes(port)) {
        current.ports.push(port);
      }
    }
  }
  return [...byPid.values()];
}

/** Parse `lsof -a -p <pids> -d cwd -Fpn` output into pid to cwd. */
export function parseCwdMap(out: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid: number | null = null;
  for (const line of out.split("\n")) {
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") {
      const value = Number(rest);
      pid = Number.isInteger(value) && value > 0 ? value : null;
    } else if (tag === "n" && pid !== null) {
      map.set(pid, rest);
    }
  }
  return map;
}

/**
 * Path containment with a component boundary, so `/wt/foo` never claims
 * `/wt/foobar`. A trailing slash on `root` is ignored.
 */
export function isUnderPath(cwd: string, root: string): boolean {
  const trimmed = root.endsWith("/") ? root.slice(0, -1) : root;
  return cwd === trimmed || cwd.startsWith(`${trimmed}/`);
}

/** The raw output of one scan, and whether it actually finished. */
export interface LsofScan {
  readonly out: string;
  /** False means the scan did not finish. `out` is then not an answer. */
  readonly complete: boolean;
}

export interface LsofScanOptions {
  /** Budget for one attempt. The scan gets two attempts. */
  readonly timeoutMs?: number;
  /** Working directory for `lsof`. Defaults to `/`. */
  readonly cwd?: string;
}

/**
 * How long one scan gets. Generous on purpose: a full listener scan measures
 * tens of milliseconds on an idle machine, so this is a ~100x margin that only
 * a genuinely saturated box reaches.
 */
const LSOF_TIMEOUT_MS = 8_000;

/** Internal marker: this attempt blew its budget and must be retried. */
class ScanIncomplete extends Data.TaggedError("ScanIncomplete")<{
  readonly argv: readonly string[];
}> {
  override get message(): string {
    return `${this.argv.join(" ")}: scan did not finish`;
  }
}

const attemptScan = Effect.fnUntraced(function* (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Effect.fn.Return<LsofScan, ScanIncomplete | ProcError> {
  const result = yield* run(argv, { cwd, timeoutMs });
  // `lsof` exits 1 for "no matches" (and for harmless per-fd warnings) while
  // still printing what it found, so the exit code is not read here. That is
  // true of exit 1 and NOT of a blown budget, which is what `timedOut` is for.
  if (!result.timedOut) return { out: result.stdout, complete: true };
  yield* Effect.logWarning(`scan exceeded ${timeoutMs}ms: ${argv.join(" ")}`);
  return yield* new ScanIncomplete({ argv });
});

/**
 * Run one `lsof`-style scan and say whether it finished.
 *
 * A blown budget is retried once, because the load spikes that cause it are
 * usually brief. Two blown budgets, or any failure to run the command at all,
 * resolve to `{ out: "", complete: false }` and log a warning. This never
 * fails, and it never reports an unfinished scan as an empty world.
 *
 * Assumes macOS/BSD `lsof` with `-F` field output.
 */
export const lsofScan = Effect.fn("probes.lsofScan")(function* (
  argv: readonly string[],
  options: LsofScanOptions = {},
): Effect.fn.Return<LsofScan> {
  const timeoutMs = options.timeoutMs ?? LSOF_TIMEOUT_MS;
  const cwd = options.cwd ?? "/";
  return yield* attemptScan(argv, cwd, timeoutMs).pipe(
    Effect.retry(Schedule.recurs(1)),
    Effect.catch(() =>
      Effect.as(
        Effect.logWarning(
          `could not complete "${argv.join(" ")}"; treating the result as unknown`,
        ),
        { out: "", complete: false } satisfies LsofScan,
      ),
    ),
    Effect.annotateLogs({ logger: "Probes" }),
  );
});

const LISTENERS_ARGV = ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"] as const;

/**
 * Every process holding a listening TCP socket, or `None` when the scan did
 * not finish. `None` means unknown; an empty array means nothing is listening.
 *
 * Assumes macOS/BSD `lsof`: `-nP` suppresses host and port name resolution,
 * `-Fpcn` selects field output with the pid, command and name fields.
 */
export const listeningProcesses = Effect.fn("probes.listeningProcesses")(function* (
  options: LsofScanOptions = {},
): Effect.fn.Return<Option.Option<ListeningProcess[]>> {
  const scan = yield* lsofScan(LISTENERS_ARGV, options);
  return scan.complete ? Option.some(parseListeners(scan.out)) : Option.none();
});

/**
 * The working directory of each of the given pids, or `None` when the scan did
 * not finish. Pids that no longer exist are simply absent from the map.
 *
 * Assumes macOS/BSD `lsof`: `-d cwd` selects the current-directory descriptor.
 */
export const processCwds = Effect.fn("probes.processCwds")(function* (
  pids: readonly number[],
  options: LsofScanOptions = {},
): Effect.fn.Return<Option.Option<Map<number, string>>> {
  if (pids.length === 0) return Option.some(new Map<number, string>());
  const scan = yield* lsofScan(
    ["lsof", "-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"],
    options,
  );
  return scan.complete ? Option.some(parseCwdMap(scan.out)) : Option.none();
});
