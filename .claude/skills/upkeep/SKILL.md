---
name: upkeep
description: Full maintenance pass on this repo - upgrade Node/pnpm, all dependencies (including majors, researched via changelogs), and GitHub Actions, then verify everything and ship a version bump (CI publishes to npm). Use when the user invokes /upkeep or asks to update/upgrade dependencies, tooling, or "outdated stuff".
---

# Upkeep: full maintenance pass

Upgrade everything in this repo that has drifted, verify it all works, then bump the version, commit, and push to main (CI publishes the new version to npm). Be thorough: majors are in scope, but every major gets changelog research before its version is bumped.

Remember this is a **published library**: dependency types can leak into the public API via declaration files, and `biome.shared.json` + `tsconfig/*` are consumed by downstream projects (omni-notify, condo, lobster, presspods). Breakage here breaks them on their next upgrade — call out anything consumer-visible in the commit message.

## 0. Sync with remote FIRST

`git fetch origin && git status`. If local main is behind, pull (rebase) **before** surveying anything. Upgrading against a stale base wastes the entire pass.

## 1. Survey (parallelize all of this)

- `pnpm outdated`
- Node: current pin in `.node-version` / `engines.node` vs latest **Active LTS** (`curl -s https://raw.githubusercontent.com/nodejs/Release/main/schedule.json`; pick the latest version whose `lts` date has passed, then latest patch from `https://nodejs.org/dist/index.json`). Don't jump to a Current (non-LTS) major.
- pnpm: `npm view pnpm version` vs `packageManager` / `engines.pnpm`
- GitHub Actions: for each `uses:` in `.github/workflows/*.yml`, `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name`

## 2. Research majors before bumping

For each **major** bump (and for pnpm/Node majors), spawn parallel research agents to read the official migration guide/changelog and report only the breaking changes that hit *this codebase's actual usage* (have the agent grep usage sites first). Minors/patches need no research — `pnpm update` handles in-range ones.

## 3. Apply

- Version pins travel together: `.node-version`, `engines.node`, `engines.pnpm`, `packageManager` (CI reads `node-version-file: ".node-version"`).
- Keep `@types/node` major **matched to the Node runtime major**, not latest.
- Biome bumps must update the `$schema` version in **both** `biome.json` and `biome.shared.json` (the latter is published) plus the devDependency; run `pnpm biome migrate --write` if it flags the schema.
- If pnpm goes to 11+: `package.json#pnpm` settings (`onlyBuiltDependencies`) move to `pnpm-workspace.yaml`.
- Install: `CI=true pnpm install --no-frozen-lockfile`, then `CI=true pnpm update` for in-range minors. (`CI=true` avoids the no-TTY modules-purge abort; `--no-frozen-lockfile` because `CI=true` implies frozen.)
- If Node changed: `fnm install <version>` locally and run all commands via `fnm exec --using=<version>` (this machine uses fnm; pnpm comes from corepack, so also set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`).
- Fix code breakage from majors. When a migration guide claims a rename, confirm against the installed d.ts before editing — guides sometimes describe aliases that still exist.

## 4. Verify (all must pass)

```
pnpm run typecheck
CI=true pnpm test
pnpm run build
pnpm run check          # biome
```

Also sanity-check the built output for a runtime break tests might miss: `node -e "import('./dist/logging/index.js').then(() => console.log('ok'))"` (any subpath export works; catches ESM/resolution slips in dist).

## 5. Ship

1. `git pull --rebase` (again — remote may have moved during the pass)
2. Bump `version` in `package.json`: patch for deps-only, minor if anything consumer-visible changed (types, shared configs), major for breaking changes.
3. Commit everything as `Bump to X.Y.Z` with a body summarizing tool/dep changes (what and why, not a file list), then `git push`.
4. Watch CI to completion: `gh run watch <id> --exit-status` (background). The publish job is the only verification of the release path — do not declare success until it's green. If CI fails, fix and push again.
5. Downstream consumers pick up the new version during their own upkeep passes — nothing to do here.
