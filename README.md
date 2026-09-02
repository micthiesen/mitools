# MiTools

Michael's shared TypeScript utility library, built on [Effect 4](https://effect.website/docs/v4/).
Every function that does I/O, waits, retries, owns a resource or coordinates
concurrency returns a typed `Effect`; the library never runs an effect itself.
You compose the pieces you need, provide their layers once, and run the result
at your program's boundary.

## Install

```bash
pnpm add @micthiesen/mitools effect@4.0.0-rc.112
```

The `sqlite`, `docstore`, `entities` and `table` modules need better-sqlite3's
native build; pnpm 10+ only runs it when allowed in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  better-sqlite3: true
```

`effect` is a **peer dependency** (`>=4.0.0-rc.112 <4.1`), never bundled and
never re-exported, so your project ends up with exactly one copy. If another
dependency drags in a different 4.x release candidate, pin it. pnpm 10+ reads
overrides from `pnpm-workspace.yaml` (pnpm 11 ignores `package.json#pnpm`):

```yaml
overrides:
  effect: 4.0.0-rc.112
```

npm uses `package.json#overrides`, yarn `resolutions`. Verify with
`pnpm why effect`: one version, one path.

## The boundary

Effects run in exactly one place per process. A long-running service:

```ts
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Docstore } from "@micthiesen/mitools/docstore";
import { Sqlite } from "@micthiesen/mitools/sqlite";
import { Logger } from "@micthiesen/mitools/logging";
import { Pushover } from "@micthiesen/mitools/pushover";
import { Scheduler } from "@micthiesen/mitools/scheduling";

const AppLayer = Layer.mergeAll(
  Docstore.layer,
  Scheduler.layer,
  Logger.layerAdapter, // Effect.log* -> Logger
).pipe(
  Layer.provideMerge(Sqlite.layerConfig), // DB_NAME, DOCKERIZED
  Layer.provideMerge(Logger.layerConfig({ onError: Pushover.logHook })), // LOG_LEVEL
  Layer.provideMerge(Pushover.layerConfig), // PUSHOVER_TOKEN, PUSHOVER_USER
  Layer.provideMerge(FetchHttpClient.layer),
);

const program = Effect.gen(function* () {
  const logger = Logger.named("Main");
  yield* logger.info("Starting");
  const scheduler = yield* Scheduler;
  yield* scheduler.register(myTask);
  yield* scheduler.start;
  yield* Effect.never; // interrupted by the process runtime on SIGTERM
}).pipe(Effect.scoped, Effect.provide(AppLayer));

Effect.runPromise(program);
```

For code that must expose Promises (an HTTP framework handler, a test helper),
build one `ManagedRuntime` from the same layer and call `runtime.runPromise(effect)`.
Nothing in this library needs `Effect.runSync`, `runFork` or a Promise twin.

## Modules

Import by subpath: `@micthiesen/mitools/<name>`. Requirements are the services
an effect needs in its `R` channel; provide them with the listed layers.

| Subpath | What | Requirements / layers |
| --- | --- | --- |
| `errors` | `OperationError`, `operationErrors(source)`, `causeMessage` | none |
| `logging` | `Logger` service, `Logger.named(name)` (a `NamedLogger` with `.extend` and `.channel`), `LogLevel`, `LogItem`, sinks (`consoleSink`, `dailyFileSink`, `channelSink`, `levelSink`, `filterSink`), capture layer, Effect logger adapter, tracer layer | `Logger.layer(...)`, `Logger.layerConfig(...)`, `Logger.layerCapture(...)`, `Logger.layerAdapter`, `Logger.layerTracer` |
| `config` | `baseConfigFields`, `baseConfig`, `isSensitiveKey`, `redactConfig`, `logConfig`; TOML providers (`tomlConfigProvider`, `layerToml`, `layerTomlWithEnv`), `required`/`withRemedy` (`ConfigRemedyError`), `withAliases` | `ConfigProvider` (defaults to env) |
| `sqlite` | `Sqlite` service: one better-sqlite3 connection, `transaction` | `Sqlite.layer({ path })`, `Sqlite.layerConfig`, `Sqlite.layerMemory` |
| `docstore` | `Docstore` service + accessors (`getDoc`, `upsertDoc`, ...), `CorruptRowError` | `Docstore.layer` (needs `Sqlite`), `Docstore.layerMemory` |
| `entities` | `Entity<Data, PK>`: typed documents keyed by primary key, TTL, migration | `Docstore` |
| `table` | `Table.make(options)`: typed real SQL tables | `Sqlite` |
| `scheduling` | `Scheduler` service, `ScheduledTask`, six-field cron | `Scheduler.layer` |
| `async` | Schedule presets (`exponentialBackoff`, `spacedUpTo`, `lockContention`, `retrySchedule`), `withRetry`, `makeDebounced` (scoped trailing-edge debounce) | none |
| `proc` | `run`, `runOk`, `runQuiet`, `runStreaming`, `terminateSubprocess`, `sanitizeLine`, `Proc*` errors; bounded by `ProcConcurrency` (8 permits) | none (`ProcConcurrency` is a `Context.Reference`) |
| `locks` | `withLock`, `acquireLock`, `tryAcquireLock`, `lockStatus`, `LockError`: a cross-process file lock with pid/mtime staleness | none |
| `probes` | `probePort` (listening / free / unknown), `lsofScan`, `listeningProcesses`, `processCwds`, `parseListeners`, `isUnderPath` | none (macOS/BSD `lsof`) |
| `boundary` | `runQuery(effect, signal)`, `forkReported(effect, report)`, `makeBoundary(runner)`, `EffectRunner` | none |
| `react` | `useEffectFiber(make, deps, runner?)`, `fiberLifecycle` | `react` (optional peer) |
| `testing` | `withVirtualTime`, `runWithVirtualTime`, `tmpDir`, `trackedTmpDirs`, `testRuntime` | `vitest` (optional peer); test files only |
| `cli` | `runMain`, `renderFailure`, `exitCodeFor` | none |
| `pushover` | `Pushover` service, `notify`, `PushoverError`, `Pushover.logHook` | `Pushover.layer(creds)` and `Pushover.layerConfig` need `HttpClient`; `Pushover.layerNoop` needs nothing |
| `karakeep` | `Karakeep` service, `addBookmark`, `KarakeepError` | `Karakeep.layer(creds)` and `Karakeep.layerConfig` need `HttpClient`; `Karakeep.layerDisabled` needs nothing |
| `http` | `httpErrorInfo(error)`: loggable view of an `HttpClientError` | none |
| `logfile` | `LogFile.make`, `LogFile.timestamped`: sectioned log files | none (`Logger` for `.log`) |
| `streams` | `streamToBuffer`, `fromReadable`, `readFdSlice`, `readFileSlice`, `jsonlTimestamp` | none |
| `collections`, `strings`, `text`, `xml`, `markdown`, `types` | pure helpers | none |
| `vitest` | `baseVitestConfig` | |
| `biome.shared.json`, `tsconfig/*.json` | shared tooling config | |

`HttpClient` comes from `effect/unstable/http` (`FetchHttpClient.layer`).

## Errors

Domain failures are `Data.TaggedError` classes with fields you can match on
(`CorruptRowError`, `InvalidKeyError`, `EntityValidationError`,
`InvalidScheduleError`, `PushoverError`, `KarakeepError`,
`KarakeepDisabledError`). Every untyped boundary (better-sqlite3, cbor,
`node:fs`, Node streams) is wrapped once as `OperationError { source, operation, cause }`
whose message reads `operation: cause`. Nothing is swallowed: a failure the
caller might act on is in the error channel.

```ts
yield* entity.get({ id }).pipe(
  Effect.catchTag("CorruptRowError", (e) => Effect.logWarning(e.message).pipe(Effect.as(Option.none()))),
);
```

## Logging

`Logger.named("Main")` is pure; its methods are effects requiring the `Logger`
service. `Logger.layer({ level, sinks, onError, onWarn, onLog })` wires it:
`level` is the threshold below which no sink sees a line, `sinks` is where
lines go (default: the console through Effect's `Console`), `onLog` is a tap
that sees every call regardless of level, and `onError`/`onWarn` run in their
own fibers so `Logger.flush` can wait for them. Add `Logger.layerAdapter` so
`Effect.logInfo` and friends (including the library's own internal logging)
reach the same sinks; annotate with `Effect.annotateLogs({ logger: "Name" })`
to name those lines. In tests, `Logger.layerCapture()` records into
`CapturedLogs` (`Logger.captured`).

**Sinks.** A `LogSink` is `{ write(item), flush? }`. Every sink receives every
line at or above `level`, in order, so a pane feed and a toast always agree.
`Logger.dailyFileSink({ directory, prefix, retainDays })` appends to one file
per local day through a single writer fiber (`Logger.flush` and the layer's
scope wait for it) and unlinks files older than `retainDays`. `channelSink`,
`levelSink` and `filterSink` narrow any sink.

**Channels.** `Logger.named("Main").channel("attention").warn("...")` tags
the line with a channel; the level never sets one, so an `error` log is not
an attention line by itself. A toast sink is `channelSink(toast, "attention")`
next to the pane sink, which guarantees a pane line behind every toast:

```ts
const AppLogger = Logger.layer({
  sinks: [
    Logger.consoleSink,
    Logger.dailyFileSink({ directory: "~/.cache/app/logs", prefix: "app" }),
    channelSink({ write: (item) => Effect.sync(() => toast(item.message)) }, "attention"),
  ],
});
```

**Spans.** `Logger.layerTracer` is a `Tracer` that writes every ended
`Effect.fn` / `Effect.withSpan` span to the logger at debug
(`Service.method 12ms { outcome, parent, attributes }`). Provide it with the
logger layer and set `level: LogLevel.DEBUG` to see them.

## Configuration files

`config` sits on Effect `Config` / `ConfigProvider`. `layerToml(path)` installs
a TOML file as the ambient provider (nested tables are `Config.nested("paths")`
or, with the default `dotted` option, `Config.string("paths.main_clone")`);
`layerTomlWithEnv(path)` lets environment variables override it
(`PATHS_MAIN_CLONE` with `constantCase: true`). `required(config, remedy)` and
`withRemedy` turn a missing or invalid key into a `ConfigRemedyError` whose
message carries a copy-pasteable fix, and `renderConfigErrors` prints several
at once. `withAliases(provider, { "paths.main_clone": ["paths.clone"] })`
reads a renamed key from its old name and logs one deprecation warning.

```ts
import { layerTomlWithEnv, renderConfigErrors, required } from "@micthiesen/mitools/config";

const mainClone = required(
  Config.string("main_clone").pipe(Config.nested("paths")),
  "set paths.main_clone in ~/.config/wt/config.toml",
);
const program = Effect.gen(function* () {
  const path = yield* mainClone;
}).pipe(
  Effect.provide(layerTomlWithEnv(configPath, { constantCase: true })),
  Effect.catchTag("ConfigRemedyError", (e) => Effect.fail(renderConfigErrors([e]))),
);
// paths.main_clone: not set
//   set paths.main_clone in ~/.config/wt/config.toml
```

## CLI entry points

`cli` is the process boundary. `runMain(program, { debug, flush })` forks the
program, interrupts it on SIGINT/SIGTERM (finalizers run), maps the outcome to
an exit code (a `number` result is the code, `void` is 0, a failure or defect
prints through `renderFailure` and exits 1, an interruption exits 130), runs
`flush` on every path and then exits. `renderFailure(cause, { debug })` prints
a tagged failure's `message` (the `operation: cause` chain), a defect's stack,
and both with `debug`.

```ts
import { runMain } from "@micthiesen/mitools/cli";

runMain(main.pipe(Effect.provide(AppLayer)), {
  debug: process.env.APP_DEBUG !== undefined,
  flush: Logger.flush.pipe(Effect.provide(AppLayer)),
});
```

## Subprocesses

`proc` runs commands as Effects with the semantics that cost incidents when
they are missing: a bounded number of concurrent children (`ProcConcurrency`,
8 permits, the acquire masked so a cancelled wait never leaks one), process
group termination (SIGTERM, one second of grace, SIGKILL, then a full join of
exit and both pipes) on interruption, and `timedOut` as a first-class result
field, because a SIGKILLed command's empty stdout is not an empty answer.

```ts
import { ProcConcurrency, run, runOk, runStreaming } from "@micthiesen/mitools/proc";

const branch = yield* runOk(["git", "rev-parse", "--abbrev-ref", "HEAD"]); // ProcNonZeroExitError on failure
const scan = yield* run(["lsof", "-nP", "-iTCP"], { cwd: "/", timeoutMs: 8_000 });
if (scan.timedOut) return; // do not read "" as "nothing listening"
yield* runStreaming(["pnpm", "install"], { onLine: (line) => log(line), killAfterMs: 600_000 });
```

`probes` is the same stance for the network: `probePort` answers
`"listening" | "free" | "unknown"`, where a timeout on our own event loop is
`unknown` and never `free`; `lsofScan` retries a blown budget once and then
reports `complete: false` instead of an empty list.

## Locks and debounce

`locks` serializes work across processes with a lock file created atomically
(`wx`) that records `{ op, phase, pid, host, startedAt }`. A holder whose pid
is dead, or whose file is older than `staleMs`, is reclaimed. Waiting uses the
`lockContention` schedule (jittered 150 ms polls up to `timeoutMs`), and
`withLock` runs the body with `acquireUseRelease`, so interruption releases.

```ts
import { withLock, tryAcquireLock, lockStatus, lockLabel } from "@micthiesen/mitools/locks";

yield* withLock("/tmp/app/deploy.lock", deploy, { op: "deploy", timeoutMs: 30_000 });

const handle = yield* tryAcquireLock(path, { op: "deploy", phase: "build" }); // Option, scoped
if (Option.isNone(handle)) {
  const held = yield* lockStatus(path);
  return Option.isSome(held) ? `busy: ${lockLabel(held.value)}` : "busy";
}
yield* handle.value.phase("upload");
```

`makeDebounced(onChange, ms)` (in `async`) is a trailing-edge debounce as a
scoped resource: `trigger`/`cancel` are effects, `triggerUnsafe`/`cancelUnsafe`
are the adapters for an `fs.watch` callback, and closing the scope cancels the
pending call.

## UI boundaries

`boundary` holds the two places a UI hands an Effect to code that cannot
yield: `runQuery(effect, signal)` for a TanStack `queryFn` (aborting the signal
interrupts the fiber) and `forkReported(effect, report)` for an event callback
(fork once, report the typed failure, never throw into React). `makeBoundary(runner)`
binds both to an `EffectRunner` (a `ManagedRuntime` fits) so a production entry
point can be driven under `TestClock` in tests. `react` adds `useEffectFiber`:
one fiber per mount, interrupted on cleanup.

```ts
useQuery({ queryKey: ["worktrees"], queryFn: ({ signal }) => runQuery(listWorktrees, signal) });
<button onClick={() => forkReported(remove(slug), (e) => toast(e.message))} />;
useEffectFiber(() => (slug ? watchStatus(slug, setStatus) : null), [slug]);
```

## Testing

Use `@effect/vitest`: `it.effect` runs under a `TestClock`, so retries,
timeouts and cron schedules are driven with `TestClock.adjust`. Persistence
tests use `Docstore.layerMemory`. See `src/**/*.spec.ts`.

`@micthiesen/mitools/testing` (test files only; it imports `vitest`) has the
helpers every consumer rewrites: `withVirtualTime(effect, "1 minute")`
(fork, adjust, join), `runWithVirtualTime` (the Promise form with its own
`TestClock.layer()`), `tmpDir(prefix)` (a scratch directory removed with the
scope), `trackedTmpDirs()` (one `afterAll` sweep per file) and
`testRuntime(layer)` (an `EffectRunner` over a test layer, for entry points
that take a runner).

## Development

```bash
pnpm test        # vitest (CI=true pnpm test for one run)
pnpm typecheck   # tsc --noEmit (patched with Effect diagnostics)
pnpm lint        # effect-tsgo diagnostics --strict (Effect rules)
pnpm check       # biome format + lint
pnpm build
```

Releases: bump `version`, commit `Bump to X.Y.Z`, push `main`; CI publishes.
See [MIGRATION.md](./MIGRATION.md) for moving from v3 and [CHANGELOG.md](./CHANGELOG.md).
