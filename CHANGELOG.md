# Changelog

## 4.1.0

The Effect second wave: the reusable Effect modules from wt move here, the
hand-rolled patterns become Effect built-ins, and the pieces neither project
had are added. No published contract changes; see MIGRATION.md "4.1".

- `async`: shared `Schedule` presets (`exponentialBackoff`, `spacedUpTo`,
  `lockContention`; `retrySchedule` builds on the first) and `makeDebounced`,
  a scoped trailing-edge debounce with `triggerUnsafe`/`cancelUnsafe` adapters.
- `proc` (new): an Effect subprocess runner on `node:child_process` with wt's
  semantics: `ProcConcurrency` permits taken under an uninterruptible mask,
  process-group termination (SIGTERM, grace, SIGKILL, full join), `timedOut`
  as a result field, `runStreaming` with `killAfterMs`, typed `Proc*` errors
  naming the argv, `sanitizeLine`.
- `locks` (new): a cross-process file lock with pid/mtime staleness,
  `lockContention` retries and `acquireUseRelease` semantics.
- `probes` (new): three-valued `probePort` and `lsofScan`, where a timeout is
  `unknown`, never `free` or "nothing listening".
- `streams`: `readFdSlice`, `readFileSlice`, `jsonlTimestamp`. `strings`:
  `pluralize`.
- `boundary`, `react`, `testing` (new): `runQuery`, `forkReported`,
  `makeBoundary`/`EffectRunner`; `useEffectFiber` (`react` optional peer);
  `withVirtualTime`, `runWithVirtualTime`, `tmpDir`, `trackedTmpDirs`,
  `testRuntime`.
- `logging`: sinks (`LogSink`, `Logger.consoleSink`, `Logger.dailyFileSink`
  with a single writer fiber and retention, `channelSink`, `levelSink`,
  `filterSink`), channels (`NamedLogger.channel`), and `Logger.layerTracer`,
  which logs every ended `Effect.fn` span at debug.
- `config`: TOML providers (`tomlConfigProvider`, `layerToml`,
  `layerTomlWithEnv`), remedy-carrying errors (`required`, `withRemedy`,
  `ConfigRemedyError`, `renderConfigErrors`) and `withAliases` for renamed keys.
- `cli` (new): `renderFailure`, `exitCodeFor`, `runMain`.
- `tsconfig/library.json` now carries the Effect language-service rules
  promoted to `warning`, so every consumer inherits the lint gate.
- Dependencies: `smol-toml`; optional peers `react` and `vitest`.

## 4.0.0

Breaking: the library is rebuilt on Effect 4 (`effect@4.0.0-rc.112`, a peer
dependency). See [MIGRATION.md](./MIGRATION.md) for every subpath.

- Every I/O, timing, retry, resource and concurrency function returns a typed
  `Effect`; the library runs nothing itself. No Promise twins, no
  `runSync`/`runPromise` inside the package.
- Services and layers: `Logger`, `Sqlite`, `Docstore`, `Scheduler`, `Pushover`,
  `Karakeep` are `Context.Service` classes with `layer` / `layerConfig`
  (reads the same environment variables as before) and test layers
  (`Docstore.layerMemory`, `Logger.layerCapture`, `Pushover.layerNoop`,
  `Karakeep.layerDisabled`). `Injector` is removed.
- Errors: `Data.TaggedError` classes with fields (`CorruptRowError`,
  `InvalidKeyError`, `EntityValidationError`, `InvalidScheduleError`,
  `PushoverError`, `KarakeepError`, `KarakeepDisabledError`); untyped
  boundaries are wrapped once as `OperationError { source, operation, cause }`
  from the new `errors` subpath.
- Logger: hooks and the tap are effects configured per layer instead of
  mutable statics; `Logger.flush` waits for hook fibers; `Logger.layerAdapter`
  routes `Effect.log*` into the same sink; console output goes through
  Effect's `Console`.
- Scheduling uses Effect's `Cron` and `Schedule.cron` (node-cron and p-queue
  removed). Runs of a task never overlap; a fire during a run is skipped.
- Retries are a `Schedule` (`retrySchedule`); `sleep`, `withTimeout`,
  `tryCatch` and `Result` are replaced by `Effect.sleep`, `Effect.timeout`,
  `Effect.try`/`Effect.result`.
- HTTP goes through `effect/unstable/http` `HttpClient` (got removed);
  `http` exports `httpErrorInfo`.
- Config uses Effect `Config` (`baseConfigFields`, `baseConfig`); zod removed.
- New subpaths: `errors`, `sqlite`.
- Time inside the library comes from `Clock`/`DateTime`, so `TestClock`
  drives expiry, retries, timeouts and cron in tests.
- Tooling: `@effect/tsgo` diagnostics run in `pnpm lint` (strict) and inside
  the patched `tsc` used by `typecheck`/`build`; CI runs lint and tests.
