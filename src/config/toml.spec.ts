import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Schema } from "effect";
import {
  ConfigFileNotFoundError,
  layerToml,
  layerTomlWithEnv,
  TomlParseError,
  tomlConfigProvider,
  tomlConfigProviderFromFile,
} from "./index.js";

const TOML = `
top = "t"

[paths]
main_clone = "/repos/main"
worktrees = ["/a", "/b"]

[dev_server]
port_base = 3000
enabled = true
started = 1979-05-27T07:32:00Z

[[servers]]
name = "alpha"

[[servers]]
name = "beta"
`;

const dir = mkdtempSync(join(tmpdir(), "mitools-config-"));
const configPath = join(dir, "config.toml");
writeFileSync(configPath, TOML);
const brokenPath = join(dir, "broken.toml");
writeFileSync(brokenPath, "a = [1,\nb = 2\n");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tomlConfigProvider", () => {
  it.effect("reads a nested table through Config.nested", () =>
    Effect.gen(function* () {
      const provider = yield* tomlConfigProvider(TOML);
      const value = yield* Config.string("main_clone").pipe(
        Config.nested("paths"),
        (config) => config.parse(provider),
      );
      assert.strictEqual(value, "/repos/main");
    }),
  );

  it.effect("reads a nested table through a dotted name", () =>
    Effect.gen(function* () {
      const provider = yield* tomlConfigProvider(TOML);
      assert.strictEqual(
        yield* Config.string("paths.main_clone").parse(provider),
        "/repos/main",
      );
      assert.strictEqual(
        yield* Config.int("dev_server.port_base").parse(provider),
        3000,
      );
      assert.strictEqual(
        yield* Config.boolean("dev_server.enabled").parse(provider),
        true,
      );
      assert.strictEqual(
        yield* Config.string("servers.0.name").parse(provider),
        "alpha",
      );
    }),
  );

  it.effect("keeps dotted names literal when dotted is false", () =>
    Effect.gen(function* () {
      const provider = yield* tomlConfigProvider(TOML, { dotted: false });
      const result = yield* Effect.result(
        Config.string("paths.main_clone").parse(provider),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("reads arrays", () =>
    Effect.gen(function* () {
      const provider = yield* tomlConfigProvider(TOML);
      const worktrees = yield* Config.schema(Schema.Array(Schema.String), [
        "paths",
        "worktrees",
      ]).parse(provider);
      assert.deepStrictEqual([...worktrees], ["/a", "/b"]);
    }),
  );

  it.effect("exposes a TOML datetime as its original representation", () =>
    Effect.gen(function* () {
      const provider = yield* tomlConfigProvider(TOML);
      assert.strictEqual(
        yield* Config.string("dev_server.started").parse(provider),
        "1979-05-27T07:32:00.000Z",
      );
    }),
  );

  it.effect("fails with TomlParseError, naming the source and position", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        tomlConfigProvider("a = [1,\nb = 2\n", { source: "config.toml" }),
      );
      assert.strictEqual(result._tag, "Failure");
      const error = result._tag === "Failure" ? result.failure : undefined;
      assert.instanceOf(error, TomlParseError);
      assert.strictEqual((error as TomlParseError).source, "config.toml");
      assert.strictEqual((error as TomlParseError).line, 2);
      assert.match((error as TomlParseError).message, /^parse config\.toml at line 2/);
    }),
  );
});

describe("tomlConfigProviderFromFile", () => {
  it.effect("reads a file from disk", () =>
    Effect.gen(function* () {
      const provider = yield* tomlConfigProviderFromFile(configPath);
      assert.strictEqual(
        yield* Config.string("paths.main_clone").parse(provider),
        "/repos/main",
      );
    }),
  );

  it.effect("fails with ConfigFileNotFoundError when the file is missing", () =>
    Effect.gen(function* () {
      const missing = join(dir, "nope.toml");
      const result = yield* Effect.result(tomlConfigProviderFromFile(missing));
      assert.strictEqual(result._tag, "Failure");
      const error = result._tag === "Failure" ? result.failure : undefined;
      assert.instanceOf(error, ConfigFileNotFoundError);
      assert.strictEqual((error as ConfigFileNotFoundError).path, missing);
    }),
  );

  it.effect("reports the file path in a parse error", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(tomlConfigProviderFromFile(brokenPath));
      assert.strictEqual(result._tag, "Failure");
      assert.instanceOf(
        result._tag === "Failure" ? result.failure : undefined,
        TomlParseError,
      );
    }),
  );
});

describe("layerToml", () => {
  it.effect("installs the file as the ambient provider", () =>
    Effect.gen(function* () {
      const value = yield* Config.string("paths.main_clone").pipe(
        Effect.provide(layerToml(configPath)),
      );
      assert.strictEqual(value, "/repos/main");
    }),
  );

  it.effect("tolerates a missing file when optional", () =>
    Effect.gen(function* () {
      const value = yield* Config.string("paths.main_clone").pipe(
        Config.withDefault("fallback"),
        Effect.provide(layerToml(join(dir, "nope.toml"), { optional: true })),
      );
      assert.strictEqual(value, "fallback");
    }),
  );

  it.effect("fails the layer when a required file is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Effect.provide(Config.string("top"), layerToml(join(dir, "nope.toml"))),
      );
      assert.strictEqual(result._tag, "Failure");
      assert.instanceOf(
        result._tag === "Failure" ? result.failure : undefined,
        ConfigFileNotFoundError,
      );
    }),
  );
});

describe("layerTomlWithEnv", () => {
  const layer = (env: Record<string, string>) => layerTomlWithEnv(configPath, { env });

  it.effect("lets the environment win over the file", () =>
    Effect.gen(function* () {
      const value = yield* Config.string("top").pipe(
        Effect.provide(layer({ top: "from-env" })),
      );
      assert.strictEqual(value, "from-env");
    }),
  );

  it.effect("falls back to the file when the environment is silent", () =>
    Effect.gen(function* () {
      const value = yield* Config.string("top").pipe(Effect.provide(layer({})));
      assert.strictEqual(value, "t");
    }),
  );

  it.effect("matches a nested key with an underscore-joined env name", () =>
    Effect.gen(function* () {
      const value = yield* Config.string("main_clone").pipe(
        Config.nested("paths"),
        Effect.provide(layer({ paths_main_clone: "/from-env" })),
      );
      assert.strictEqual(value, "/from-env");
    }),
  );

  it.effect("matches a nested key in CONSTANT_CASE when asked", () =>
    Effect.gen(function* () {
      const value = yield* Config.string("main_clone").pipe(
        Config.nested("paths"),
        Effect.provide(
          layerTomlWithEnv(configPath, {
            env: { PATHS_MAIN_CLONE: "/shouty" },
            constantCase: true,
          }),
        ),
      );
      assert.strictEqual(value, "/shouty");
    }),
  );

  it.effect("still reads nested file keys, nested or dotted", () =>
    Effect.gen(function* () {
      const value = yield* Config.string("main_clone").pipe(
        Config.nested("paths"),
        Effect.provide(layer({ OTHER: "x" })),
      );
      assert.strictEqual(value, "/repos/main");
      const dotted = yield* Config.string("paths.main_clone").pipe(
        Effect.provide(layer({ OTHER: "x" })),
      );
      assert.strictEqual(dotted, "/repos/main");
    }),
  );
});

describe("provider composition", () => {
  it.effect("works with ConfigProvider.orElse in either direction", () =>
    Effect.gen(function* () {
      const toml = yield* tomlConfigProvider(TOML);
      const env = ConfigProvider.fromEnv({ env: { top: "env" } });
      assert.strictEqual(
        yield* Config.string("top").parse(ConfigProvider.orElse(env, toml)),
        "env",
      );
      assert.strictEqual(
        yield* Config.string("top").parse(ConfigProvider.orElse(toml, env)),
        "t",
      );
    }),
  );
});
