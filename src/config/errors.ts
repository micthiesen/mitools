/**
 * Typed failures for configuration loading, plus the combinators that turn an
 * Effect `ConfigError` into a message a user can act on.
 *
 * A `ConfigError` says what the schema wanted; it does not say what the user
 * should type to fix it. `ConfigRemedyError` carries that fix, so a CLI can
 * print `paths.main_clone: not set` followed by the exact edit to make.
 */
import { type Config, ConfigProvider, Data, Effect, Schema, SchemaIssue } from "effect";
import { causeMessage } from "../errors/index.js";

/** The TOML text could not be parsed. `line` and `column` come from the parser. */
export class TomlParseError extends Data.TaggedError("TomlParseError")<{
  /** Where the text came from: a file path, or a label such as `"<inline>"`. */
  readonly source: string;
  readonly cause: unknown;
  readonly line?: number;
  readonly column?: number;
}> {
  override get message(): string {
    const where =
      this.line === undefined ? "" : ` at line ${this.line}, column ${this.column}`;
    const [first] = causeMessage(this.cause).split("\n");
    return `parse ${this.source}${where}: ${first}`;
  }
}

/** The config file does not exist. Distinct from a read failure or a parse failure. */
export class ConfigFileNotFoundError extends Data.TaggedError(
  "ConfigFileNotFoundError",
)<{
  readonly path: string;
}> {
  override get message(): string {
    return `config file not found: ${this.path}`;
  }
}

/**
 * A configuration problem paired with the fix for it. `message` reads
 *
 * ```text
 * paths.main_clone: not set
 *   set paths.main_clone in ~/.config/wt/config.toml
 * ```
 */
export class ConfigRemedyError extends Data.TaggedError("ConfigRemedyError")<{
  /** The dotted key the user would edit, for example `paths.main_clone`. */
  readonly key: string;
  /** What is wrong, for example `not set` or `Expected a finite number`. */
  readonly problem: string;
  /** A copy-pasteable fix, for example `set paths.main_clone in ~/.config/wt/config.toml`. */
  readonly remedy: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `${this.key}: ${this.problem}\n  ${this.remedy}`;
  }
}

/** Options for {@link withRemedy}. Only `remedy` is required. */
export interface RemedyOptions {
  /** The fix to print under the problem. */
  readonly remedy: string;
  /** The key to name. Defaults to the path the failing config actually read. */
  readonly key?: string;
  /** The provider path to probe for presence. Defaults to the failing path, then `key.split(".")`. */
  readonly path?: ConfigProvider.Path;
  /** Overrides the derived problem text. */
  readonly problem?: string;
}

const LEAF_TAGS: ReadonlySet<string> = new Set([
  "InvalidType",
  "InvalidValue",
  "MissingKey",
  "UnexpectedKey",
  "Forbidden",
  "OneOf",
]);

/** Walks the `Pointer` chain of a schema issue and collects the path it points at. */
function issuePath(issue: SchemaIssue.Issue): ConfigProvider.Path {
  const segments: Array<string | number> = [];
  let current: SchemaIssue.Issue = issue;
  while (current._tag === "Pointer") {
    for (const segment of current.path) {
      segments.push(typeof segment === "number" ? segment : String(segment));
    }
    current = current.issue;
  }
  return segments;
}

/** The innermost issue of a `Pointer` chain, when it is a leaf the formatter understands. */
function leafIssue(issue: SchemaIssue.Issue): SchemaIssue.Leaf | undefined {
  let current: SchemaIssue.Issue = issue;
  while (current._tag === "Pointer") current = current.issue;
  return LEAF_TAGS.has(current._tag) ? (current as SchemaIssue.Leaf) : undefined;
}

/**
 * The provider path a `ConfigError` was raised for, or `undefined` when the
 * failure was the source itself rather than a value.
 */
export function configErrorPath(
  error: Config.ConfigError,
): ConfigProvider.Path | undefined {
  if (!Schema.isSchemaError(error.cause)) return undefined;
  const path = issuePath(error.cause.issue);
  return path.length === 0 ? undefined : path;
}

/**
 * One short line describing a `ConfigError`, without the `SchemaError(...)`
 * wrapper or the trailing `at [...]` location.
 */
export function configErrorProblem(error: Config.ConfigError): string {
  if (!Schema.isSchemaError(error.cause)) return error.cause.message;
  const leaf = leafIssue(error.cause.issue);
  if (leaf !== undefined) return SchemaIssue.defaultLeafHook(leaf);
  return error.message
    .replace(/^SchemaError\(/, "")
    .replace(/\)$/, "")
    .split("\n")
    .filter((line) => !/^\s*at \[/.test(line))
    .map((line) => line.trim())
    .join(" ")
    .trim();
}

/** True when the active provider has no value at `path` (as opposed to a bad one). */
const isAbsent = Effect.fnUntraced(function* (path: ConfigProvider.Path) {
  const provider = yield* ConfigProvider.ConfigProvider;
  const node = yield* Effect.result(provider.load(path));
  return node._tag === "Success" && node.success === undefined;
});

const remedyFor = Effect.fnUntraced(function* (
  error: Config.ConfigError,
  options: RemedyOptions,
) {
  const path =
    options.path ??
    configErrorPath(error) ??
    (options.key === undefined ? [] : options.key.split("."));
  const key = options.key ?? (path.length === 0 ? "config" : path.join("."));
  const absent = path.length === 0 ? false : yield* isAbsent(path);
  const problem = options.problem ?? (absent ? "not set" : configErrorProblem(error));
  return new ConfigRemedyError({ key, problem, remedy: options.remedy, cause: error });
});

/**
 * Turns a failing `Config` into a `ConfigRemedyError` that names the key, says
 * whether it is missing or invalid, and prints the fix. The original
 * `ConfigError` is kept as `cause`.
 *
 * ```ts
 * const mainClone = withRemedy(Config.string("main_clone").pipe(Config.nested("paths")), {
 *   remedy: "set paths.main_clone in ~/.config/wt/config.toml",
 * });
 * ```
 */
export function withRemedy<A>(
  self: Config.Config<A>,
  options: RemedyOptions,
): Effect.Effect<A, ConfigRemedyError> {
  return Effect.catch(self, (error) =>
    Effect.flatMap(remedyFor(error, options), (remedy) => Effect.fail(remedy)),
  );
}

/**
 * {@link withRemedy} for the common case: the key is the one the config itself
 * read, and a missing value reads `not set`.
 */
export function required<A>(
  self: Config.Config<A>,
  remedy: string,
): Effect.Effect<A, ConfigRemedyError> {
  return withRemedy(self, { remedy });
}

/**
 * Joins several remedy errors into one block, so a loader can report every
 * problem at once instead of one per run.
 *
 * ```text
 * wt: invalid config at ~/.config/wt/config.toml
 *   - paths.main_clone: not set
 *     set paths.main_clone in ~/.config/wt/config.toml
 * ```
 */
export function renderConfigErrors(
  errors: Iterable<ConfigRemedyError>,
  options?: { readonly header?: string },
): string {
  const blocks = Array.from(errors, (error) =>
    error.message
      .split("\n")
      .map((line, index) => (index === 0 ? `  - ${line}` : `  ${line}`))
      .join("\n"),
  );
  if (blocks.length === 0) return "";
  const header = options?.header;
  return header === undefined ? blocks.join("\n") : [header, ...blocks].join("\n");
}
