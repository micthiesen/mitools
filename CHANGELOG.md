# Changelog

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
