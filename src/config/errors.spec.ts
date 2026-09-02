import { assert, describe, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect } from "effect";
import {
  ConfigRemedyError,
  configErrorPath,
  renderConfigErrors,
  required,
  withRemedy,
} from "./index.js";

const provider = ConfigProvider.fromUnknown({
  paths: { main_clone: "/repos/main" },
  dev_server: { port_base: "not-a-number" },
});

const withProvider = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.provideService(effect, ConfigProvider.ConfigProvider, provider);

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.result(effect), (result) =>
    result._tag === "Failure" ? result.failure : undefined,
  );

const mainClone = Config.string("main_clone").pipe(Config.nested("paths"));
const missing = Config.string("main").pipe(Config.nested("paths"));
const portBase = Config.int("port_base").pipe(Config.nested("dev_server"));

const REMEDY = "set paths.main in ~/.config/wt/config.toml";

describe("withRemedy", () => {
  it.effect("passes a value through untouched", () =>
    withProvider(
      Effect.gen(function* () {
        assert.strictEqual(
          yield* withRemedy(mainClone, { remedy: REMEDY }),
          "/repos/main",
        );
      }),
    ),
  );

  it.effect("reports a missing key as not set, with the remedy", () =>
    withProvider(
      Effect.gen(function* () {
        const error = yield* failureOf(withRemedy(missing, { remedy: REMEDY }));
        assert.instanceOf(error, ConfigRemedyError);
        assert.strictEqual((error as ConfigRemedyError).key, "paths.main");
        assert.strictEqual((error as ConfigRemedyError).problem, "not set");
        assert.strictEqual(
          (error as ConfigRemedyError).message,
          `paths.main: not set\n  ${REMEDY}`,
        );
      }),
    ),
  );

  it.effect("reports a present but invalid value with the schema's complaint", () =>
    withProvider(
      Effect.gen(function* () {
        const error = yield* failureOf(
          withRemedy(portBase, { remedy: "set dev_server.port_base to an integer" }),
        );
        assert.instanceOf(error, ConfigRemedyError);
        assert.strictEqual((error as ConfigRemedyError).key, "dev_server.port_base");
        assert.notStrictEqual((error as ConfigRemedyError).problem, "not set");
        assert.match((error as ConfigRemedyError).problem, /Expected/);
        assert.notMatch((error as ConfigRemedyError).problem, /\n/);
      }),
    ),
  );

  it.effect("keeps the ConfigError as the cause", () =>
    withProvider(
      Effect.gen(function* () {
        const error = yield* failureOf(withRemedy(missing, { remedy: REMEDY }));
        const cause = (error as ConfigRemedyError).cause;
        assert.strictEqual((cause as Config.ConfigError)._tag, "ConfigError");
        assert.deepStrictEqual(configErrorPath(cause as Config.ConfigError), [
          "paths",
          "main",
        ]);
      }),
    ),
  );

  it.effect("honours an explicit key and problem", () =>
    withProvider(
      Effect.gen(function* () {
        const error = yield* failureOf(
          withRemedy(missing, {
            key: "paths.main_clone",
            problem: "is required",
            remedy: REMEDY,
          }),
        );
        assert.strictEqual(
          (error as ConfigRemedyError).message,
          `paths.main_clone: is required\n  ${REMEDY}`,
        );
      }),
    ),
  );
});

describe("required", () => {
  it.effect("is withRemedy with the key taken from the config", () =>
    withProvider(
      Effect.gen(function* () {
        const error = yield* failureOf(required(missing, REMEDY));
        assert.strictEqual(
          (error as ConfigRemedyError).message,
          `paths.main: not set\n  ${REMEDY}`,
        );
      }),
    ),
  );
});

describe("renderConfigErrors", () => {
  const errors = [
    new ConfigRemedyError({ key: "paths.main_clone", problem: "not set", remedy: "a" }),
    new ConfigRemedyError({ key: "stage.prefix", problem: "not set", remedy: "b" }),
  ];

  it("renders one block per error", () => {
    assert.strictEqual(
      renderConfigErrors(errors),
      "  - paths.main_clone: not set\n    a\n  - stage.prefix: not set\n    b",
    );
  });

  it("prepends a header when given one", () => {
    assert.strictEqual(
      renderConfigErrors(errors.slice(0, 1), { header: "wt: invalid config" }),
      "wt: invalid config\n  - paths.main_clone: not set\n    a",
    );
  });

  it("renders nothing for no errors", () => {
    assert.strictEqual(renderConfigErrors([], { header: "unused" }), "");
  });
});
