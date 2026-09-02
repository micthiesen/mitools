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
| `logging` | `Logger` service, `Logger.named(name)` (a `NamedLogger`), `LogLevel`, `LogItem`, capture layer, Effect logger adapter | `Logger.layer(...)`, `Logger.layerConfig(...)`, `Logger.layerCapture(...)`, `Logger.layerAdapter` |
| `config` | `baseConfigFields`, `baseConfig`, `isSensitiveKey`, `redactConfig`, `logConfig` | `ConfigProvider` (defaults to env) |
| `sqlite` | `Sqlite` service: one better-sqlite3 connection, `transaction` | `Sqlite.layer({ path })`, `Sqlite.layerConfig`, `Sqlite.layerMemory` |
| `docstore` | `Docstore` service + accessors (`getDoc`, `upsertDoc`, ...), `CorruptRowError` | `Docstore.layer` (needs `Sqlite`), `Docstore.layerMemory` |
| `entities` | `Entity<Data, PK>`: typed documents keyed by primary key, TTL, migration | `Docstore` |
| `table` | `Table.make(options)`: typed real SQL tables | `Sqlite` |
| `scheduling` | `Scheduler` service, `ScheduledTask`, six-field cron | `Scheduler.layer` |
| `async` | `withRetry`, `retrySchedule` (exponential backoff + jitter) | none |
| `pushover` | `Pushover` service, `notify`, `PushoverError`, `Pushover.logHook` | `Pushover.layer(creds)` and `Pushover.layerConfig` need `HttpClient`; `Pushover.layerNoop` needs nothing |
| `karakeep` | `Karakeep` service, `addBookmark`, `KarakeepError` | `Karakeep.layer(creds)` and `Karakeep.layerConfig` need `HttpClient`; `Karakeep.layerDisabled` needs nothing |
| `http` | `httpErrorInfo(error)`: loggable view of an `HttpClientError` | none |
| `logfile` | `LogFile.make`, `LogFile.timestamped`: sectioned log files | none (`Logger` for `.log`) |
| `streams` | `streamToBuffer`, `fromReadable` | none |
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
service. `Logger.layer({ level, onError, onWarn, onLog })` is the console sink:
`level` is the console threshold, `onLog` sees every call regardless,
`onError`/`onWarn` run in their own fibers and `Logger.flush` waits for them.
Add `Logger.layerAdapter` so `Effect.logInfo` and friends (including the
library's own internal logging) reach the same sink; annotate with
`Effect.annotateLogs({ logger: "Name" })` to name those lines. In tests,
`Logger.layerCapture()` records into `CapturedLogs` (`Logger.captured`).

## Testing

Use `@effect/vitest`: `it.effect` runs under a `TestClock`, so retries,
timeouts and cron schedules are driven with `TestClock.adjust`. Persistence
tests use `Docstore.layerMemory`. See `src/**/*.spec.ts`.

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
