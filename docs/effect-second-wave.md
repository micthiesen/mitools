# Effect second wave: what to pull into mitools from wt, and what to build new

Written 2026-09-02 after `wt` (`/Users/michael/.wt`) finished its Effect 4
review (commits `5c947e8..38a53ef` on wt's `main`). It lists reusable pieces
that now exist in wt as idiomatic Effect code, the ones that should be
replaced by Effect built-ins rather than ported, and things neither project
has yet. The matching goal is `docs/goals/effect-second-wave.txt`.

Ground rules that apply to every item:

- Effect is a **peer dependency** of mitools (narrow rc range while 4.0 is an
  rc), never a regular dependency and never re-exported. Consumers end up
  with one copy.
- Effect-returning functions take the **plain name**. A Promise adapter exists
  only where an external contract requires it and is named `fooPromise`; a
  synchronous fire-and-forget over a fiber takes Effect's `Unsafe` suffix
  (`cancelUnsafe`). No `fooEffect`/`foo` twins, no `Effect.runPromise`
  islands inside the library.
- Domain failures are `Data.TaggedError` classes with meaningful fields and a
  `message` override; untyped boundaries are wrapped once with the shared
  `OperationError`/`operationErrors(source)` helper.
- Named effectful functions are `Effect.fn("name")`; module-private helpers
  and generics are `Effect.fnUntraced`.
- Read `node_modules/effect/AGENTS.md`, `node_modules/effect/ai-docs/src/`
  and `node_modules/effect/dist/*.d.ts` before relying on an API; Effect 4
  renamed much of Effect 3. wt's `AGENTS.md` "Effect first" bullet and
  `docs/architecture.md` "Effect boundary" are the consumer-side statement of
  the same rules.

Each item names the wt source to read (absolute paths into
`/Users/michael/.wt`), what is generic, what is coupled to wt, and the
decision.

## 0. What landed (mitools 4.1.0, 2026-09-02)

Every item below is one of: **done** (in mitools, with the subpath),
**replaced** by an Effect built-in, or **declined** with the reason. Section
numbers refer to the plan that follows.

| Item | Outcome |
| --- | --- |
| 1.1 `errors` | done: `@micthiesen/mitools/errors` already had wt's shape (`OperationError`, `operationErrors`, `causeMessage`); wt deletes its copy |
| 3 Schedule presets | done: `async` `exponentialBackoff`, `spacedUpTo`, `lockContention`; `retrySchedule` builds on `exponentialBackoff`; `locks` and `probes` use them |
| 1.2 `proc` | done: `@micthiesen/mitools/proc` on `node:child_process`. Effect's `effect/unstable/process` was evaluated and not used as the core: it needs `@effect/platform-node` (a second platform peer), has no process-group kill and no `timedOut` discriminator. wt's interruption, abort, timeout and `killAfterMs` tests are ported as real-subprocess specs. Differences: `cwd` defaults to `process.cwd()`, the limit is the `ProcConcurrency` reference, a signal-killed child reports `128 + signum` |
| 1.3 `locks` | done: `@micthiesen/mitools/locks` on the config-free design (`wx` create, pid/mtime staleness, `lockContention` retries, `acquireUseRelease`). Node has no flock, so `withFileLock`/`withFileLockAt` (blocking flock on a shared inode) are declined; a live but wedged holder is reclaimed after `staleMs` |
| 1.4 debounce | done: `async` `makeDebounced` (scoped; `trigger`/`cancel` effects plus `triggerUnsafe`/`cancelUnsafe`). `makeDebouncedUnsafe` declined: open a `Scope` instead |
| 1.5 probes | done: `@micthiesen/mitools/probes` `probePort`, `portInUse`, `lsofScan`, `listeningProcesses`, `processCwds`, parsers. `allocateDevPort` and `reapWorktreeListeners` stay in wt (policy) |
| 1.6 helpers | done: `streams` `readFdSlice`, `readFileSlice`, `jsonlTimestamp`; `strings` `pluralize`. Declined: `prepareTailQuery` (bun:sqlite), `closeSilent` (trivial, FSWatcher-specific), `encodeRemoteArgs`/`decodeRemoteArgs` (no SSH helper in mitools yet) |
| 1.7 boundaries | done: `@micthiesen/mitools/boundary` (`runQuery`, `forkReported`, `makeBoundary`, `EffectRunner`), `@micthiesen/mitools/react` (`useEffectFiber`, `fiberLifecycle`; `react` optional peer) |
| 1.8 test helpers | done: `@micthiesen/mitools/testing` `withVirtualTime`, `runWithVirtualTime`, `tmpDir`, `trackedTmpDirs`, `testRuntime`. wt's `git()` fixture declined (Bun.spawnSync, wt-specific) |
| 2 `pollUntil` | replaced: `Effect.repeat(check, { schedule: spacedUpTo(intervalMs, budgetMs), until })` |
| 2 `createWorkerInfoFetcher`, `fetchOrigin` single-flight | replaced: `RcRef` / `RcMap` for refcounted shared fibers, `Effect.cached` / `Cache` for single-flight. Not ported |
| 2 `state-db` / `wtstate` | reverse direction: wt adopts `sqlite`, `docstore`, `table` (unchanged in 4.1) |
| 2 hand-rolled `deps` objects | replaced by `Context.Service` + `Layer`; every seam in mitools is one |
| 3 logger sinks | done: `LogSink`, `Logger.consoleSink`, `Logger.dailyFileSink` (Queue-backed writer, retention), `channelSink`/`levelSink`/`filterSink`, `NamedLogger.channel`. Contract kept: every sink sees every line (a toast always has a pane line), the level never sets the channel |
| 3 tracer layer | done: `Logger.layerTracer` |
| 3 `config` on Effect | done: `tomlConfigProvider`, `layerToml`, `layerTomlWithEnv`, `required`/`withRemedy`/`ConfigRemedyError`, `renderConfigErrors`, `withAliases`. wt's loader can sit on it |
| 3 CLI helpers | done: `@micthiesen/mitools/cli` `renderFailure`, `exitCodeFor`, `runMain` |
| 3 language-service gate | done: the rules are in `tsconfig/library.json`; consumers inherit them. The plugin runs through `@effect/tsgo` here (TypeScript 7), wt keeps `@effect/language-service` on TypeScript 5 with the same rule names |
| 4.5 wt follow-up | not done here (the goal says do not edit wt). The import list is in the release notes |
| 5 things not to move | not moved |

## 1. Move from wt into mitools (generic, already Effect-shaped)

### 1.1 `errors`: `OperationError`, `operationErrors`, `causeMessage`

Source: `src/core/errors.ts` (about 60 lines).

`OperationError { source, operation, cause }` with a `message` getter that
reads `operation: cause`, and `operationErrors(source)` returning
`{ wrap, sync, promise }` for the three ways untyped code enters Effect (a
throwing sync call, a Promise API, a dynamic `import()`). `causeMessage`
turns any thrown value into text.

Generic: entirely. Coupling: none. Decision: mitools owns it (the existing
`src/errors` module is the home); wt imports it back and deletes its copy.
This is the shape every other item below wraps its boundaries with, so it
goes first.

### 1.2 `proc`: subprocess runner

Source: `src/core/proc.ts` (about 600 lines) and `proc.test.ts` (real
subprocess tests: interruption kills and joins the child, a timed-out command
returns `timedOut: true` with captured output, an external `AbortSignal`
interrupts a queued acquire).

What it does: `run` (captured stdout/stderr/exit code), `runOk` (trimmed
stdout, typed `ProcNonZeroExitError`/`ProcTimeoutError`), `runQuiet`
(boolean), `runStreaming` (per-line callback, `killAfterMs`),
`terminateSubprocess` (SIGTERM, bounded grace, SIGKILL, full join). A
process-wide `Semaphore` bounds concurrent spawns (8) and the permit is
released on every exit path, including interruption of a queued acquire.
Errors: `ProcSpawnError | ProcReadError | ProcNonZeroExitError |
ProcTimeoutError | ProcInterruptedError`, each with a message naming the
argv. `sanitizeLine` strips ANSI/CR noise from streamed lines.

Semantics worth keeping exactly (they cost incidents in wt, see its
`AGENTS.md` "Traps"): a SIGKILLed command's empty stdout is not an empty
answer (`RunResult.timedOut` is the discriminator); kill the process GROUP
(`detached: true`, `process.kill(-pid)`), not just the child; the semaphore
acquire is masked so a cancelled take never leaks a permit.

Coupling: `cwd` defaults to `config.paths.mainClone`. Make `cwd` required, or
read it from a service. Decision: port to `@micthiesen/mitools/proc`. First
check Effect 4's own child-process API
(`node_modules/effect/ai-docs/src/60_child-process/`); if it provides
process-group termination, a timed-out discriminator and per-line streaming,
build on it, otherwise keep the `Bun.spawn`/`node:child_process` core and
expose the same Effect surface. Port the interruption tests with it.

### 1.3 `locks`: cross-process file lock

Source: `src/core/locks.ts` (`withAsyncFileLock`, `tryAcquireLock`,
`withFileLock`, `lockStatus`, `lockAge`, `readLockMeta`) and
`locks.test.ts` (interruption releases the lock; contention retries).

flock-style lock files with PID + timestamp metadata, a jittered
`Schedule.spaced(pollMs).pipe(Schedule.jittered, Schedule.upTo(timeoutMs))`
retry for the async form, `Effect.acquireUseRelease` so the fd closes and the
lock releases on interruption, and staleness detection (dead PID, old mtime).
`humanAge`/`lockLabel` are display helpers.

Coupling: lock directory comes from wt's config; take it as a parameter or a
`Layer`. Decision: move. Anything using mitools' sqlite persistence from more
than one process wants this (wt's `update/exec.ts` has a second, config-free
variant `acquireUpdateGitLock` with TestClock tests worth folding in).

### 1.4 `async`: scoped debounce over a callback source

Source: `src/core/repo-watch.ts` `makeDebounced` / `makeDebouncedUnsafe`
and `repo-watch.test.ts` (TestClock-driven).

A `Debounced` resource built in a `Scope`: `trigger()` from an `fs.watch`
callback restarts a sleep fiber (interrupt-before-replace), the trailing edge
runs `onChange`, `cancel` is an Effect and `cancelUnsafe` the synchronous
adapter for callback code, and the scope's finalizer cancels everything.
Decision: move into `async`. The rest of `repo-watch.ts` (which paths to
watch) is wt-specific.

### 1.5 `net`/`process` probes that are three-valued

Sources: `src/core/dev-server.ts` `probePort` (listening / free / unknown,
where a timeout on our own event loop is `unknown`, never "free"; unknown is
retried once) and `allocateDevPort`; `src/core/reaper.ts` `lsofScan`,
`parseListeners`, `parseCwdMap`, `isUnderPath` (which listening processes have
a cwd under a path, with a blown `lsof` budget treated as unknown and
narrated, not as "nothing listening").

Decision: move the probe and the lsof scan (macOS `lsof` assumptions
documented). wt keeps the dev-server policy around them.

### 1.6 Small pure helpers

- `src/core/tail-util.ts`: `readFdSlice`, `readFileSlice`, `jsonlTimestamp`,
  `prepareTailQuery` (tail a growing file by offset). Move to `streams` or
  `text`.
- `src/core/remote-protocol.ts`: `encodeRemoteArgs`/`decodeRemoteArgs`
  (argv that survives a remote login shell re-parsing an SSH command).
  Move if mitools grows an SSH helper; otherwise leave.
- `src/core/text.ts` `pluralize`: trivial, `strings`.

### 1.7 Boundary helpers for consumers with a UI

Sources: `src/state/queries/boundary.ts` `runQuery(effect, signal)` (TanStack
`queryFn` boundary, AbortSignal wired to fiber interruption),
`src/tui/effect-boundary.ts` `forkReported(effect, report)` (event-callback
boundary: fork once, report the typed failure, never throw into React),
`src/tui/hooks/useEffectFiber.ts` (one fiber per mount, interrupted on
cleanup), and `src/state/queries/boundary.test.ts` (aborting the signal
interrupts the effect).

Decision: new subpath, e.g. `@micthiesen/mitools/boundary` (framework-free
`runQuery`/`forkReported`) and `@micthiesen/mitools/react` (`useEffectFiber`,
with `react` as an optional peer). Every UI consumer repeats these.

### 1.8 Test helpers

Sources: `src/core/test-fixtures.ts` (`trackedTmpDirs`, a `git` fixture
helper), and the fork-adjust-join TestClock harness that appears in six wt
test files (`trust.test.ts`, `sessions.test.ts`, `session-messaging.test.ts`,
`poll.test.ts`, `fetch.test.ts`, `auto-merge-retry.test.ts`):

```ts
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust(1_000);
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())),
);
```

Decision: `@micthiesen/mitools/testing` with `runWithVirtualTime(effect, ms)`,
`trackedTmpDirs`, and a `ManagedRuntime`-based seam helper (wt's
`auto-merge-retry.ts` takes an injectable `runFork` so its production entry
point can run under TestClock; that pattern is worth a documented helper).

## 2. Replace with an Effect built-in instead of porting

- `src/core/poll.ts` `pollUntil`: `Effect.repeat`/`Effect.retry` with
  `Schedule.spaced(...).pipe(Schedule.upTo(...))` covers it. At most a
  one-line preset.
- `src/core/worker-info.ts` `createWorkerInfoFetcher` (refcounted shared
  in-flight fiber; last joiner cancels) and `src/core/worktree.ts`
  `fetchOrigin` single-flight (`Ref` of the running fiber, joiners attach):
  Effect 4 has `RcRef`, `RcMap`, `Cache`, `ScopedCache`, `Effect.cached`.
  Use those. Do not port the hand-rolled versions.
- `src/core/state-db.ts` / `src/core/wtstate/`: JSON state in sqlite with a
  writer sidecar. Reverse direction: once mitools' `table`/`docstore` are
  Effect services, wt adopts them.
- wt's hand-rolled `deps` objects (`createSessionMessenger(overrides)`,
  `DaemonDependencies`, `CleanDeps`): these are what `Context.Service` +
  `Layer` are for; in mitools, start with services (the seams are real
  because mitools has many consumers).

## 3. New in neither project

- **Effect `Logger` adapter + logger as a service** (in the first-wave goal).
  Add a sink abstraction: wt's attention/firehose channels and its toast sink
  (`src/core/logger.ts`, `setEventSink`, `setToastSink`, the `Queue` +
  single-consumer-fiber writer with `flushLogger`) become sinks; daily-file
  rotation lives in mitools. Keep wt's contract: every background toast has
  a pane line behind it; `log.error` does not auto-promote.
- **Tracer layer for `Effect.fn` spans.** Both projects now name every effect
  and nothing consumes the spans. A layer that writes span name, duration and
  parent to the log at debug (Effect's `Tracer` service; `effect/unstable`
  has OTLP if ever needed) makes the naming pay off.
- **`config` on Effect `Config`/`ConfigProvider`** with a TOML provider,
  typed errors whose message carries a copy-pasteable remedy (wt's
  `Errors.reqStr` idea in `src/core/config.ts`), and loader aliases for
  renamed keys. wt's bespoke loader can sit on it later.
- **Shared `Schedule` presets**: jittered exponential with a cap, spaced up
  to a deadline, the lock-contention schedule. wt has three copies
  (`lifecycle.ts` `removeLockSchedule`, `locks.ts`, `stack-ops/shared.ts`).
- **CLI entry helpers**: wt's `src/main.ts` `renderFailure` (a tagged
  failure prints its `message` chain, a defect prints its stack, `WT_DEBUG`
  adds the stack) plus an `Effect.runMain`-style runner mapping exit codes
  and flushing the logger on every path (see
  `node_modules/effect/ai-docs/src/01_effect/06_running/10_run-main.ts`).
- **Language-service gate**: promote the suggestion-tier
  `@effect/language-service` rules to warning in the shared `tsconfig`
  (wt's `tsconfig.json` has the list); at their default tier they never
  reach a CLI run, and `effectFnOpportunity` is inert even when promoted.
  Ship it in `tsconfig/library.json` so every consumer inherits it.

## 4. Order

1. `errors` (1.1) and the `Schedule` presets (3), because everything else
   wraps its boundaries with them.
2. `proc`, `locks`, `async` debounce, probes (1.2 to 1.5).
3. `boundary`/`react`/`testing` subpaths (1.7, 1.8).
4. Logger sinks, tracer layer, `config` on Effect `Config`, CLI helpers (3).
5. A wt follow-up that replaces its local copies with the mitools imports
   and adopts the Effect built-ins in section 2. Keep wt's
   `scripts/broken-module-check.sh` green: a mitools import must not drag a
   heavy module graph into `wt status`.

## 5. Things NOT to move

`src/core/logger.ts`'s channel policy, `dev-server.ts` slot policy,
`reaper.ts`'s worktree semantics, `repo-watch.ts` path sets,
`worker-info.ts`'s protocol, everything under `src/tui/` except the three
boundary helpers, and every AGENTS.md "Traps" bullet: those are wt's
incidents, not library rules.
