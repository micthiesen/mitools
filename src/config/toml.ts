/**
 * A TOML-backed Effect `ConfigProvider`, for CLIs that keep their settings in a
 * file such as `~/.config/<tool>/config.toml` and let environment variables
 * override it.
 *
 * Nested tables are addressable two ways. The canonical form is Effect's own
 * nesting, which works with any provider:
 *
 * ```ts
 * Config.string("main_clone").pipe(Config.nested("paths"));
 * Config.schema(Schema.String, ["paths", "main_clone"]);
 * ```
 *
 * As a convenience these providers also split a dotted name, so
 * `Config.string("paths.main_clone")` reads the same value. `ConfigProvider`
 * itself does not do this (`fromUnknown` treats `"paths.main_clone"` as one
 * literal key), so the dotted form only works on a provider built here, or on
 * one you pass through {@link withDottedPaths}. Pass `{ dotted: false }` when a
 * table key genuinely contains a dot.
 *
 * Array-of-tables entries are addressed by index: `["servers", 0, "name"]`, or
 * `"servers.0.name"` in the dotted form.
 */
import { readFile } from "node:fs/promises";
import { ConfigProvider, Effect, type Layer } from "effect";
import { parse, TomlError } from "smol-toml";
import { type OperationError, operationErrors } from "../errors/index.js";
import { ConfigFileNotFoundError, TomlParseError } from "./errors.js";

const io = operationErrors("config");

/** Options shared by the TOML provider constructors. */
export interface TomlProviderOptions {
  /** Label used in parse errors. Defaults to the file path, or `"<inline>"`. */
  readonly source?: string;
  /** Set to `false` to read `"a.b"` as one literal key instead of a nested path. */
  readonly dotted?: boolean;
}

/**
 * TOML dates parse to `Date` subclasses, which `ConfigProvider.fromUnknown`
 * cannot render as a value. `toISOString()` on a `TomlDate` returns the
 * original TOML representation (`1979-05-27`, `07:32:00`), so the value stays
 * readable as a string and by `Config.date`.
 */
function normalizeToml(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeToml);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        normalizeToml(child),
      ]),
    );
  }
  return value;
}

const splitPath = (path: ConfigProvider.Path, numeric: boolean): ConfigProvider.Path =>
  path.flatMap((segment) => {
    if (typeof segment !== "string" || !segment.includes(".")) return [segment];
    return segment
      .split(".")
      .map((part) => (numeric && /^\d+$/.test(part) ? Number(part) : part));
  });

/**
 * Lets a provider answer dotted names (`"paths.main_clone"`) as nested paths.
 * A digits-only segment is tried as an array index first and as an object key
 * second, so both `servers.0.name` and a table literally named `0` resolve.
 */
export function withDottedPaths(
  provider: ConfigProvider.ConfigProvider,
): ConfigProvider.ConfigProvider {
  return ConfigProvider.orElse(
    ConfigProvider.mapInput(provider, (path) => splitPath(path, true)),
    ConfigProvider.mapInput(provider, (path) => splitPath(path, false)),
  );
}

/** Builds a `ConfigProvider` from TOML text. Fails with `TomlParseError`. */
export const tomlConfigProvider = Effect.fn("config.tomlConfigProvider")(function* (
  text: string,
  options?: TomlProviderOptions,
) {
  const source = options?.source ?? "<inline>";
  const root = yield* Effect.try({
    // `asNeeded` keeps integers too large for a JS number as bigint rather than
    // failing the whole document; the provider stringifies them.
    try: () => parse(text, { integersAsBigInt: "asNeeded" }),
    catch: (cause) =>
      cause instanceof TomlError
        ? new TomlParseError({ source, cause, line: cause.line, column: cause.column })
        : new TomlParseError({ source, cause }),
  });
  const provider = ConfigProvider.fromUnknown(normalizeToml(root));
  return options?.dotted === false ? provider : withDottedPaths(provider);
});

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ENOENT";

/**
 * Reads and parses a TOML file. A missing file fails with
 * `ConfigFileNotFoundError` so a caller can treat it as "no config yet";
 * anything else the file system raises stays an `OperationError`.
 */
export const tomlConfigProviderFromFile = Effect.fn(
  "config.tomlConfigProviderFromFile",
)(function* (path: string, options?: TomlProviderOptions) {
  const text = yield* io
    .promise(`read ${path}`, () => readFile(path, "utf8"))
    .pipe(
      Effect.catchIf(
        (error) => isNotFound(error.cause),
        () => Effect.fail(new ConfigFileNotFoundError({ path })),
      ),
    );
  return yield* tomlConfigProvider(text, { source: path, ...options });
});

/** Options for the layer constructors. */
export interface TomlLayerOptions extends TomlProviderOptions {
  /** Treat a missing file as an empty config instead of failing the layer. */
  readonly optional?: boolean;
}

/** An empty provider: every lookup misses. */
const emptyProvider = ConfigProvider.fromUnknown({});

const providerForLayer = Effect.fnUntraced(function* (
  path: string,
  options?: TomlLayerOptions,
) {
  const provider = tomlConfigProviderFromFile(path, options);
  if (options?.optional !== true) return yield* provider;
  return yield* provider.pipe(
    Effect.catchTag("ConfigFileNotFoundError", () => Effect.succeed(emptyProvider)),
  );
});

/**
 * Installs a TOML file as the program's `ConfigProvider`, replacing the default
 * environment provider. The layer fails if the file is missing, unless
 * `{ optional: true }`.
 */
export function layerToml(
  path: string,
  options?: TomlLayerOptions,
): Layer.Layer<never, TomlParseError | ConfigFileNotFoundError | OperationError> {
  return ConfigProvider.layer(providerForLayer(path, options));
}

/** Options for {@link layerTomlWithEnv}. */
export interface TomlWithEnvOptions extends TomlLayerOptions {
  /** The environment to read. Defaults to the process environment. */
  readonly env?: Record<string, string>;
  /**
   * Read the environment in CONSTANT_CASE, so the file key `paths.main_clone`
   * is overridden by `PATHS_MAIN_CLONE` instead of `paths_main_clone`.
   * Defaults to `false`, which matches env var names to key names exactly.
   */
  readonly constantCase?: boolean;
}

/**
 * The usual CLI shape: values come from the TOML file, and an environment
 * variable of the same name wins over the file. Pass `env` in tests.
 *
 * Environment lookups follow `ConfigProvider.fromEnv`: path segments are
 * joined with `_`, so a nested key reads `paths_main_clone` unless
 * `{ constantCase: true }` makes it `PATHS_MAIN_CLONE`.
 */
export function layerTomlWithEnv(
  path: string,
  options?: TomlWithEnvOptions,
): Layer.Layer<never, TomlParseError | ConfigFileNotFoundError | OperationError> {
  const env = ConfigProvider.fromEnv(
    options?.env === undefined ? undefined : { env: options.env },
  );
  const overrides =
    options?.constantCase === true ? ConfigProvider.constantCase(env) : env;
  return ConfigProvider.layer(
    Effect.map(providerForLayer(path, options), (toml) =>
      ConfigProvider.orElse(overrides, toml),
    ),
  );
}
