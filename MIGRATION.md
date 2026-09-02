# Migrating to @micthiesen/mitools 4 (Effect)

Version 4 rebuilds the library on Effect 4. Every function that touches I/O,
time, retries, resources or concurrency now returns an `Effect`; you run it
once at your boundary. This guide goes subpath by subpath: old call, new call,
what you run at the boundary, how to provide layers.

## Setup

1. `pnpm add effect@4.0.0-rc.112 @micthiesen/mitools@4`. `effect` is a peer
   dependency; the range is `>=4.0.0-rc.112 <4.1`. If `pnpm why effect` shows
   two versions, pin it: pnpm 10+ reads `overrides:` from `pnpm-workspace.yaml`
   (`overrides:\n  effect: 4.0.0-rc.112`; pnpm 11 ignores `package.json#pnpm`),
   npm uses `package.json#overrides`, yarn `resolutions`.
2. Optional but recommended: `@effect/tsgo` for Effect diagnostics
   (`npx @effect/tsgo setup`). This repo's `tsconfig.json` shows the promoted
   rule set.
3. Tests: `pnpm add -D @effect/vitest@4.0.0-rc.112` and write time-dependent
   tests with `it.effect` + `TestClock`.

## The boundary

v3 code called sync/async functions anywhere. v4 code builds effects and runs
them in one place:

```ts
// v3
Injector.configure({ config });
const logger = new Logger("Main");
logger.info("hi");
await scheduler.shutdown();

// v4
const AppLayer = Layer.mergeAll(Docstore.layer, Scheduler.layer, Logger.layerAdapter).pipe(
  Layer.provideMerge(Sqlite.layerConfig),
  Layer.provideMerge(Logger.layerConfig({ onError: Pushover.logHook })),
  Layer.provideMerge(Pushover.layerConfig),
  Layer.provideMerge(FetchHttpClient.layer),
);
const main = Effect.gen(function* () {
  const logger = Logger.named("Main");
  yield* logger.info("hi");
  // ...
}).pipe(Effect.scoped, Effect.provide(AppLayer));
Effect.runPromise(main);
```

Layers own resources: the SQLite connection closes and the scheduler stops when
the scope that built `AppLayer` closes. For SIGTERM handling use
`@effect/platform-node`'s `NodeRuntime.runMain(main)` or wire `process.on` to a
`Deferred` yourself.

Framework code that needs Promises (Express/Hono handlers, vitest helpers):
`const runtime = ManagedRuntime.make(AppLayer); runtime.runPromise(effect)`;
dispose it on shutdown. Do not sprinkle `Effect.runSync`/`runPromise` through
application code.

## `config`

| v3 | v4 |
| --- | --- |
| `baseConfigSchema.extend({...}).parse(process.env)` (zod) | `Config.all({ ...baseConfigFields, MY_KEY: Config.string("MY_KEY") })` then `yield*` it (reads the `ConfigProvider`, env by default) |
| `Injector.configure({ config })` / `Injector.config` | removed. Each service reads its own keys: `Sqlite.layerConfig`, `Logger.layerConfig`, `Pushover.layerConfig`, `Karakeep.layerConfig`. Pass explicit values with `Sqlite.layer({ path })`, `Logger.layer({ level })`, ... |
| `logConfig(config)` | `yield* logConfig(config)` (logs via `Effect.logInfo`); `redactConfig(config)` is the pure part |
| `isSensitiveKey` | unchanged |
| `stringBoolean` | unchanged (kept for zod-based consumer schemas) |

`PUSHOVER_TOKEN` in `baseConfig` is a `Redacted<string>` (`Redacted.value(x)`).
zod is no longer a dependency of the library. A consumer that keeps a zod
config can keep it; nothing in v4 needs the zod object.

Tests: replace `Injector.reset()` with providing a `ConfigProvider`:
`Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ LOG_LEVEL: "debug" })))`.

## `logging`

| v3 | v4 |
| --- | --- |
| `new Logger("Main")` | `Logger.named("Main")` (pure) |
| `logger: Logger` (the type) | `logger: NamedLogger`; `Logger` is now the service tag you provide with a layer |
| `logger.info(msg, ...args)` (sync) | `yield* logger.info(msg, ...args)` (`Effect<void, never, Logger>`) |
| `logger.extend("Child")` | same, pure |
| `Logger.onError = hook` (default Pushover) | `Logger.layer({ onError: Pushover.logHook })`; hooks return effects and may require services (`Logger.layer<R>` carries `R`) |
| `Logger.onWarn = hook` | `Logger.layer({ onWarn })` |
| `Logger.onLog = tap` | `Logger.layer({ onLog })`, an effectful tap that sees every level |
| `await Logger.flush()` | `yield* Logger.flush` |
| `LOG_LEVEL` via Injector | `Logger.layerConfig(options)` reads `LOG_LEVEL`; `Logger.layer({ level })` sets it explicitly |
| `new Logger(name, { capture: true })` + `getCapturedLogs()` | `Logger.layerCapture()` + `yield* Logger.captured` / `Logger.clearCaptured` |
| `LogTapItem`, `LogItem` (captured logs) | one `LogItem` (`timestamp, level, loggerName, message, args, formattedArgs`); `Logger.captured` resolves a `ReadonlyArray<LogItem>` |
| `ErrorNotification`, `OnErrorHook` | `LogNotification`, `LogHook` |

`Effect.logInfo/…` from your own code and from the library reach the same
sink through `Logger.layerAdapter` (requires `Logger`). The logger name of an
`Effect.log*` line is the `logger` log annotation (`Effect.annotateLogs({ logger: "X" })`)
or `"effect"`. Console output goes through Effect's `Console` service, so
`TestConsole` captures it in tests.

Wrapping hooks (the alert throttle pattern) becomes function composition:
`Logger.layer({ onError: throttle(Pushover.logHook) })` where `throttle` returns a
`LogHook` that decides whether to call the inner hook.

## `sqlite` (new), `docstore`

| v3 | v4 |
| --- | --- |
| implicit connection from `DB_NAME` / `DOCKERIZED` | `Sqlite.layerConfig` (same keys, same parsing: `DOCKERIZED` is true only for a case-insensitive "true") or `Sqlite.layer({ path })`; `Sqlite.layerMemory` for tests |
| `getDb()` | `const { db } = yield* Sqlite` |
| `closeDb()` | closing the layer's scope |
| `getDoc(pk)` → `T \| undefined` | `yield* getDoc<T>(pk)` → `Option<T>`; fails `CorruptRowError` on an unreadable row |
| `upsertDoc`, `deleteDoc`, `hasDoc`, `countBy*`, `getKeysByPrefix`, `cleanupExpired`, `touchDoc`, `getDocsBy*`, `getRawRow` (→ `Option`), `getRawRowsByPrefix` | same names, now effects requiring `Docstore` (accessors) or methods on `yield* Docstore` |
| `transaction(fn)` | `docstore.transaction(name, (tx) => ...)` with the synchronous `DocstoreSync` helpers |
| `clearDocstore()` | `yield* clearDocstore` |

Provide `Docstore.layer` (needs `Sqlite`). The `blobs` schema is ensured when
the layer builds. Failures from better-sqlite3/cbor are `OperationError` with
`source: "docstore"` (opening or closing the connection: `source: "sqlite"`).

## `entities`

Constructing an `Entity` is unchanged and still pure (module level is fine).
Every method is an effect requiring `Docstore`:

| v3 | v4 |
| --- | --- |
| `entity.get(pk)` → `Data \| undefined` | `yield* entity.get(pk)` → `Option<Data>` |
| `entity.patch(...)`, `entity.update(...)` → `Data \| undefined` | → `Option<Data>` |
| `entity.upsert(data, opts)` | `yield* entity.upsert(data, opts)`; a rejecting `validate` fails with `EntityValidationError` (also applied to the result of `patch`/`update`) |
| `Entity.migrateAll()` at startup | `yield* Entity.migrateAll()` after `Docstore.layer` is provided |
| `getPk` throws `Error` on a bad component | throws `InvalidKeyError` (the effect methods fail with it) |

`validate` is still a synchronous `(unknown) => Data`; pass
`Schema.decodeUnknownSync(MySchema)` or a zod `.parse`.

## `table`

| v3 | v4 |
| --- | --- |
| `new Table<T>(options)` (creates schema in the constructor) | `const table = yield* Table.make<T>(options)` (requires `Sqlite`) |
| `table.insert(row)` → boolean | `yield* table.insert(row)` |
| `upsert`, `query`, `all`, `clear` | same names, effects |

## `scheduling`

| v3 | v4 |
| --- | --- |
| `class MyTask extends ScheduledTask { run(): Promise<void> }` | `const myTask: ScheduledTask<E, R> = { name, schedule, jitterMs?, runOnStartup?, run: Effect }` |
| `new Scheduler(logger)` | `const scheduler = yield* Scheduler` with `Scheduler.layer` |
| `scheduler.register(task)` (throws on bad cron) | `yield* scheduler.register(task)` fails `InvalidScheduleError`; the task's requirements are captured from the caller's context |
| `scheduler.start()` | `yield* scheduler.start` (requires `Scope`; fibers die with the scope) |
| `await scheduler.shutdown()` | `yield* scheduler.shutdown` (waits for runs in flight) |

node-cron and p-queue are gone; scheduling uses Effect's `Cron` and
`Schedule.cron`. Six-field, seconds-first expressions are unchanged. One
behaviour changed: a fire that lands while the same task is still running is
skipped rather than queued, so a task that overruns its interval runs at the
next match after it finishes instead of back-to-back.

## `async`

| v3 | v4 |
| --- | --- |
| `withRetry(() => promise, opts)` | `withRetry(effect, opts)` or `Effect.retry(effect, retrySchedule(opts))` |
| `opts.logger` | removed; retries log via `Effect.logWarning` (route with `Logger.layerAdapter`) |
| `sleep(ms)` | `Effect.sleep(ms)` |
| `withTimeout(promise, ms)` / `TimeoutError` | `Effect.timeout(effect, ms)` (fails `Cause.TimeoutError`) or `Effect.timeoutOption` |
| `tryCatch`, `tryCatchSync`, `Result` | `Effect.try`, `Effect.tryPromise`, `Effect.result` (Effect's `Result`) |

## `pushover`

| v3 | v4 |
| --- | --- |
| `await notify(message)` (silent when unconfigured) | `yield* notify(message)` (accessor requiring `Pushover`) with `Pushover.layerConfig` or `Pushover.layer({ token, user })`. No `PUSHOVER_USER`: the service is the no-op (`enabled === false`). No `PUSHOVER_TOKEN`: only messages carrying their own `token` are sent, as before |
| errors thrown as `Error` | `PushoverError { status, body, cause }` |

Both layers need `HttpClient` from `effect/unstable/http`
(`FetchHttpClient.layer`). `Pushover.logHook` is the old default error hook.

## `karakeep`

| v3 | v4 |
| --- | --- |
| `addBookmark(input, logger)` → URL or `undefined` (failures logged) | `yield* addBookmark(input)` → URL; fails `KarakeepError { operation, url, bookmarkId, cause }` or `KarakeepDisabledError` |
| `new KarakeepClient(url, key)` | `Karakeep.layer({ baseUrl, apiKey })`; `Karakeep.layerConfig` reads `KARAKEEP_URL` / `KARAKEEP_API_KEY` |

got is gone; requests go through `HttpClient` with `retryTransient` and a
10-second timeout. A failure attaching tags carries `bookmarkId` so the caller
knows the bookmark exists.

## `http`

`extractHttpError` (got) is now `httpErrorInfo` for `HttpClientError`:
`{ kind, statusCode, url, method, description, message }`. It returns any
other value unchanged, so if your code still uses got directly, keep a local
copy of the v3 function for those call sites.

## `logfile`

| v3 | v4 |
| --- | --- |
| `new LogFile(path, mode)` | `yield* LogFile.make(path, mode)` |
| `LogFile.timestamped(dir)` | `yield* LogFile.timestamped(dir)` (uses `DateTime.now`) |
| `file.section(h, c)` | `yield* file.section(h, c)` (`OperationError` on fs failure) |
| `file.log(logger, level, h, c, opts)` | same, effect requiring `Logger` |

## `streams`

`streamToBuffer(readable)` returns `Effect<Buffer, OperationError>`.
`fromReadable(readable)` gives an Effect `Stream<Uint8Array>`.

## `markdown`

`logTimestamp(date?)` takes the date; from Effect code pass
`DateTime.toDate(yield* DateTime.now)`.

## 4.1: the second wave

4.1 adds subpaths and extends existing ones without changing a published
contract. Nothing below is required to upgrade; it lists what moved so a
consumer with a local copy (wt) can delete it.

### `logging` additions

| Local copy | mitools 4.1 |
| --- | --- |
| a file logger with a Queue worker and `flushLogger` | `Logger.dailyFileSink({ directory, prefix, retainDays })` in `Logger.layer({ sinks })`; `Logger.flush` and the layer scope drain it |
| `setEventSink` / `setToastSink` mutable globals | sinks in `Logger.layer({ sinks: [pane, channelSink(toast, "attention")] })`; every sink sees every line, so a toast always has a pane line |
| `log.attention.warn(text)` / `log.event.info(text)` | `Logger.named(name).channel("attention").warn(text)`; the channel rides on `LogItem.channel`; `error` does not promote |
| nothing consumed `Effect.fn` span names | `Logger.layerTracer` logs each ended span at debug |

`NamedLogger` gains `channelName` and `channel(name)`; `LogItem` gains an
optional `channel`; `LoggerOptions` gains `sinks`. `Logger.layer()` with no
`sinks` still prints to the console exactly as in 4.0.

### `async` additions

| Local copy | mitools 4.1 |
| --- | --- |
| `pollUntil({ check, budgetMs, intervalMs })` | `Effect.repeat(check, { schedule: spacedUpTo(intervalMs, budgetMs), until: (ok) => ok })` |
| `Schedule.spaced(150).pipe(Schedule.jittered, Schedule.upTo({ duration }))` (three copies) | `lockContention(timeoutMs, pollMs)` |
| a jittered exponential with a cap | `exponentialBackoff({ baseDelayMs, maxDelayMs })` (`retrySchedule` is this plus an attempt limit and a warning per retry) |
| `makeDebounced(onChange, ms)` / `makeDebouncedUnsafe` | `makeDebounced(onChange, ms)` (scoped; `trigger`/`cancel` are effects, `triggerUnsafe`/`cancelUnsafe` the callback adapters). A consumer without a scope opens one with `Scope.make` |

### New subpaths

| Local copy (wt) | mitools 4.1 |
| --- | --- |
| `core/proc.ts` `run`, `runOk`, `runQuiet`, `runStreaming`, `terminateSubprocess`, `sanitizeLine`, `Proc*Error` | `@micthiesen/mitools/proc`, same names and semantics on `node:child_process`. `cwd` defaults to `process.cwd()` (wt passed its main clone); the concurrency limit is the `ProcConcurrency` reference (8) instead of a module semaphore; `RunResult.timedOut` is always present; `streamLines` takes a Node `Readable`; `terminateSubprocess` takes a `ChildProcess` (or anything with `exitCode`, `kill`, `once("exit")`) |
| `core/locks.ts` `withAsyncFileLock`, `tryAcquireLock`, `lockStatus`, `lockAge`, `lockLabel`, `humanAge`; `update/exec.ts` `acquireUpdateGitLockAt` | `@micthiesen/mitools/locks` `withLock(path, effect, { op, pollMs, timeoutMs })`, `acquireLock`, `tryAcquireLock` (scoped, `Option`), `lockStatus`, `lockAge(meta, nowMs)`, `lockLabel`, `humanAge`, `LockError { path, operation }`. Lock paths are explicit (no lock directory config). No flock in Node: staleness is a dead pid or an old mtime, so `withFileLock`/`withFileLockAt` (blocking flock) have no equivalent. `LockMeta.phase_started` is `phaseStarted` |
| `core/dev-server.ts` `probePort`, `PortProbe`; `core/reaper.ts` `lsofScan`, `parseListeners`, `parseCwdMap`, `isUnderPath` | `@micthiesen/mitools/probes` `probePort`, `portInUse`, `lsofScan` (`{ out, complete }`), `listeningProcesses` / `processCwds` (`Option`, `None` = the scan did not finish), `parseListeners`, `parseCwdMap`, `isUnderPath` |
| `core/tail-util.ts` `readFdSlice`, `readFileSlice`, `jsonlTimestamp` | `@micthiesen/mitools/streams`, as effects (`OperationError` with `source: "streams"`; `jsonlTimestamp` falls back to the `Clock`) |
| `core/text.ts` `pluralize` | `@micthiesen/mitools/strings` |
| `state/queries/boundary.ts` `runQuery`; `tui/effect-boundary.ts` `forkReported` | `@micthiesen/mitools/boundary`, plus `makeBoundary(runner)` and `EffectRunner` for an injectable runtime |
| `tui/hooks/useEffectFiber.ts` | `@micthiesen/mitools/react` `useEffectFiber(make, deps, runner?)`; `react` is an optional peer |
| `core/test-fixtures.ts` `trackedTmpDirs`; the fork/adjust/join harness in six test files; the injectable `runFork` in `auto-merge-retry.ts` | `@micthiesen/mitools/testing` `trackedTmpDirs`, `tmpDir` (scoped), `withVirtualTime` / `runWithVirtualTime`, `testRuntime(layer)` (an `EffectRunner` for a production entry point that takes one) |
| `main.ts` `renderFailure` and the exit/flush wiring | `@micthiesen/mitools/cli` `renderFailure`, `exitCodeFor`, `runMain(program, { debug, flush })` |
| `core/config.ts` `Errors.reqStr` and the TOML loader's error list | `@micthiesen/mitools/config` `layerToml` / `layerTomlWithEnv` / `tomlConfigProvider`, `required(config, remedy)` / `withRemedy`, `ConfigRemedyError`, `renderConfigErrors`, `withAliases` |

### Shared tooling

`tsconfig/library.json` now carries the `@effect/language-service` plugin
block with the suggestion-tier rules promoted to `warning`, so every project
extending it inherits the same `effect-tsgo diagnostics --strict` gate. A
consumer that had its own `plugins` entry can delete it; one that needs a
different severity overrides the key in its own `tsconfig.json`.

## Unchanged

`collections`, `strings`, `text`, `xml`, `types`, `vitest`, `biome.shared.json`,
`tsconfig/*.json`.

## Testing your migrated code

```ts
import { it } from "@effect/vitest";
import { TestClock } from "effect/testing";

const TestLayer = Layer.mergeAll(Docstore.layerMemory, Scheduler.layer, Logger.layerAdapter).pipe(
  Layer.provideMerge(Logger.layerCapture()),
);

it.effect("retries", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(withRetry(flaky, { baseDelayMs: 1000 }));
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestLayer)),
);
```
