import { assert, describe, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Layer } from "effect";
import { Logger } from "../logging/index.js";
import { LogLevel } from "../logging/types.js";
import { withAliases } from "./index.js";

/** Routes `Effect.log*` into a capturing mitools `Logger`. */
const LogCapture = Logger.layerAdapter.pipe(Layer.provideMerge(Logger.layerCapture()));

const base = ConfigProvider.fromUnknown({
  paths: { main: "/old", worktrees: "/wt" },
  new: { key: "new-value" },
  devserver: { port_base: "3000" },
});

describe("withAliases", () => {
  it.effect("falls back to the old key when the new one is absent", () =>
    Effect.gen(function* () {
      const provider = withAliases(base, { "paths.main_clone": ["paths.main"] });
      const value = yield* Config.string("main_clone").pipe(
        Config.nested("paths"),
        (config) => config.parse(provider),
      );
      assert.strictEqual(value, "/old");
    }).pipe(Effect.provide(LogCapture)),
  );

  it.effect("prefers the new key when both exist", () =>
    Effect.gen(function* () {
      const provider = withAliases(ConfigProvider.fromUnknown({ a: "new", b: "old" }), {
        a: ["b"],
      });
      assert.strictEqual(yield* Config.string("a").parse(provider), "new");
      const logs = yield* Logger.captured;
      assert.deepStrictEqual(logs, []);
    }).pipe(Effect.provide(LogCapture)),
  );

  it.effect("warns once per deprecated key", () =>
    Effect.gen(function* () {
      const provider = withAliases(base, { "paths.main_clone": ["paths.main"] });
      const mainClone = Config.string("main_clone").pipe(Config.nested("paths"));
      yield* mainClone.parse(provider);
      yield* mainClone.parse(provider);
      const logs = yield* Logger.captured;
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0]?.level, LogLevel.WARN);
      assert.strictEqual(logs[0]?.loggerName, "Config");
      assert.match(
        logs[0]?.message ?? "",
        /paths\.main.*deprecated.*paths\.main_clone/,
      );
    }).pipe(Effect.provide(LogCapture)),
  );

  it.effect("stays quiet when warn is false", () =>
    Effect.gen(function* () {
      const provider = withAliases(
        base,
        { "paths.main_clone": ["paths.main"] },
        { warn: false },
      );
      yield* Config.string("main_clone").pipe(Config.nested("paths"), (config) =>
        config.parse(provider),
      );
      assert.deepStrictEqual(yield* Logger.captured, []);
    }).pipe(Effect.provide(LogCapture)),
  );

  it.effect("aliases a whole table by prefix", () =>
    Effect.gen(function* () {
      const provider = withAliases(base, { dev_server: ["devserver"] });
      const value = yield* Config.int("port_base").pipe(
        Config.nested("dev_server"),
        (config) => config.parse(provider),
      );
      assert.strictEqual(value, 3000);
    }).pipe(Effect.provide(LogCapture)),
  );

  it.effect("tries several old names in order", () =>
    Effect.gen(function* () {
      const provider = withAliases(ConfigProvider.fromUnknown({ third: "3" }), {
        first: ["second", "third"],
      });
      assert.strictEqual(yield* Config.string("first").parse(provider), "3");
    }).pipe(Effect.provide(LogCapture)),
  );

  it.effect("misses when neither the new key nor an alias exists", () =>
    Effect.gen(function* () {
      const provider = withAliases(base, { "paths.main_clone": ["paths.main"] });
      const result = yield* Effect.result(Config.string("absent").parse(provider));
      assert.strictEqual(result._tag, "Failure");
    }).pipe(Effect.provide(LogCapture)),
  );
});
