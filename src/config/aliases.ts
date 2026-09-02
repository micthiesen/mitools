/**
 * Key aliases, for the release where a config key is renamed but existing files
 * still spell it the old way.
 */
import { ConfigProvider, Effect } from "effect";

/** A map from the current key to the old keys it replaced, most recent first. */
export type ConfigAliases = Readonly<Record<string, ReadonlyArray<string>>>;

/** Options for {@link withAliases}. */
export interface AliasOptions {
  /** Log a warning the first time each old key answers a lookup. Defaults to `true`. */
  readonly warn?: boolean;
}

const splitKey = (key: string): ConfigProvider.Path =>
  key.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));

const startsWith = (path: ConfigProvider.Path, prefix: ConfigProvider.Path): boolean =>
  path.length >= prefix.length &&
  prefix.every((segment, index) => String(path[index]) === String(segment));

/**
 * Wraps a provider so a renamed key still resolves from its old name. The
 * current key is always tried first; an old key is only consulted when the
 * current one is absent, and using it logs one warning per alias (annotated
 * `logger: "Config"`, so the mitools `Logger` adapter names it).
 *
 * The mapping is by path prefix, so aliasing a whole table works:
 * `{ "dev_server": ["devserver"] }` also resolves `dev_server.port_base`.
 *
 * ```ts
 * const provider = withAliases(base, { "paths.main_clone": ["paths.main"] });
 * ```
 */
export function withAliases(
  provider: ConfigProvider.ConfigProvider,
  aliases: ConfigAliases,
  options?: AliasOptions,
): ConfigProvider.ConfigProvider {
  const entries = Object.entries(aliases).map(([key, olds]) => ({
    key,
    segments: splitKey(key),
    olds: olds.map((old) => ({ key: old, segments: splitKey(old) })),
  }));
  const warn = options?.warn !== false;
  const warned = new Set<string>();

  return ConfigProvider.make(
    Effect.fnUntraced(function* (path: ConfigProvider.Path) {
      const direct = yield* provider.load(path);
      if (direct !== undefined) return direct;
      for (const entry of entries) {
        if (!startsWith(path, entry.segments)) continue;
        const rest = path.slice(entry.segments.length);
        for (const old of entry.olds) {
          const node = yield* provider.load([...old.segments, ...rest]);
          if (node === undefined) continue;
          if (warn && !warned.has(old.key)) {
            warned.add(old.key);
            yield* Effect.logWarning(
              `Config key "${old.key}" is deprecated; rename it to "${entry.key}"`,
            ).pipe(Effect.annotateLogs({ logger: "Config" }));
          }
          return node;
        }
      }
      return undefined;
    }),
  );
}
