# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@micthiesen/mitools` is Michael's shared TypeScript utility library, published to npm and consumed by sibling projects (`omni-notify`, `condo`, `lobster`, `presspods`). It ships code **and** shared tooling config: `biome.shared.json`, `tsconfig/node.json` + `tsconfig/library.json`, and `baseVitestConfig` (`./vitest` export) are part of the published package — changes to them ripple into every consumer.

This file is canonical for AI-agent guidance; `AGENTS.md` (Codex) is a symlink to it, and `.codex/skills` symlinks to `.claude/skills`. Edit the `.claude`/CLAUDE.md versions only.

## Commands

```bash
pnpm test                    # vitest (watch mode; CI=true pnpm test for a single run)
pnpm vitest run src/persistence/table.spec.ts   # single test file
pnpm typecheck               # tsc --noEmit
pnpm build                   # rm -fr dist && tsc
pnpm check                   # biome lint + format (fix with: pnpm biome check --write .)
```

## Releasing

CI (`.github/workflows/npm-package.yml`) publishes to npm on every push to `main` and silently skips already-published versions. To release: bump `version` in `package.json` (deps-only → patch; new APIs → minor; breaking → major), commit as `Bump to X.Y.Z`, push. There is no manual publish step.

## Architecture

- **Independent modules, subpath exports.** There is no root index; consumers import `@micthiesen/mitools/<module>`. Each entry in `package.json#exports` maps to a directory under `src/` (built to `dist/` by tsc). Adding a module = new `src/<name>/` + an `exports` entry.
- **ESM-only, NodeNext resolution**: relative imports must use `.js` extensions.
- **Config / DI** (`config/`): consumers extend `baseConfigSchema` (zod) and call `Injector.configure({ config })` once at startup; library modules read `Injector.config` lazily (`DB_NAME`, `LOG_LEVEL`, `PUSHOVER_*`, `DOCKERIZED`). `logConfig()` prints config with sensitive keys redacted (`isSensitiveKey` patterns). Tests use `Injector.reset()`.
- **Persistence** (`persistence/`) — three layers over one better-sqlite3 database per `DB_NAME` (WAL mode; path prefixed `/data/` when `DOCKERIZED`):
  - `docstore` owns the connection (`getDb()`) and stores CBOR-encoded blobs in a single `blobs` (pk, data) table.
  - `Entity<Data, PKProps>` layers prefix-keyed documents (`$name#pk1#pk2`) on the docstore; get-by-pk/getAll/upsert/delete only, deliberately no querying.
  - `Table<T>` is typed real SQL tables (columns, indexes) sharing the docstore connection; schema is created idempotently in the constructor. `insert()` is INSERT OR IGNORE and returns whether a row was inserted.
- **Logging** (`logging/`): `Logger` builds hierarchical names via `.extend(name)`. Static hooks `Logger.onError` (defaults to Pushover notify when credentials are configured) and `Logger.onWarn`; async hook promises are tracked so `Logger.flush()` can await them before shutdown. Works before `Injector` is configured (falls back to DEBUG level).
- **Scheduling** (`scheduling/`): `Scheduler` registers abstract `ScheduledTask`s — **6-field** node-cron expressions (seconds first), validated at registration; each task gets its own `PQueue` so runs never overlap; supports `jitterMs` and `runOnStartup`.

## Tests

`*.spec.ts` colocated with source. Persistence specs write scratch `*.db`/`-shm`/`-wal` files to the repo root; they're gitignored — don't commit or clean-fail on them.
