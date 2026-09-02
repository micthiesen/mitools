import { assert, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { Logger } from "../logging/Logger.js";
import { LogLevel } from "../logging/types.js";
import { baseConfig, isSensitiveKey, logConfig, redactConfig } from "./base.js";

const provider = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(env));

const captureLayer = Logger.layerAdapter.pipe(
  Layer.provideMerge(Logger.layerCapture()),
);

describe("baseConfig", () => {
  it.effect("falls back to the documented defaults", () =>
    Effect.gen(function* () {
      const config = yield* baseConfig;

      assert.strictEqual(config.LOG_LEVEL, LogLevel.INFO);
      assert.strictEqual(config.DOCKERIZED, false);
      assert.strictEqual(config.DB_NAME, "docstore.db");
      assert.isUndefined(config.PUSHOVER_USER);
      assert.isUndefined(config.PUSHOVER_TOKEN);
    }).pipe(Effect.provide(provider({}))),
  );

  it.effect("parses provided values", () =>
    Effect.gen(function* () {
      const config = yield* baseConfig;

      assert.strictEqual(config.LOG_LEVEL, LogLevel.WARN);
      assert.strictEqual(config.DOCKERIZED, true);
      assert.strictEqual(config.DB_NAME, "custom.db");
      assert.strictEqual(config.PUSHOVER_USER, "user-key");
    }).pipe(
      Effect.provide(
        provider({
          LOG_LEVEL: "warn",
          DOCKERIZED: "true",
          DB_NAME: "custom.db",
          PUSHOVER_USER: "user-key",
        }),
      ),
    ),
  );

  it.effect("reads PUSHOVER_TOKEN as a Redacted value", () =>
    Effect.gen(function* () {
      const config = yield* baseConfig;

      assert.isTrue(Redacted.isRedacted(config.PUSHOVER_TOKEN));
      assert.strictEqual(Redacted.value(config.PUSHOVER_TOKEN!), "app-token");
      assert.notInclude(String(config.PUSHOVER_TOKEN), "app-token");
    }).pipe(Effect.provide(provider({ PUSHOVER_TOKEN: "app-token" }))),
  );

  it.effect("fails on an unknown LOG_LEVEL", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(baseConfig);

      assert.isTrue(result._tag === "Failure");
    }).pipe(Effect.provide(provider({ LOG_LEVEL: "loud" }))),
  );
});

describe("isSensitiveKey", () => {
  it("matches known sensitive key shapes", () => {
    const sensitive = [
      "API_KEY",
      "apiKey",
      "api-key",
      "PUSHOVER_TOKEN",
      "clientSecret",
      "CLIENT_SECRET",
      "PASSWORD",
      "passwd",
      "CREDENTIALS",
      "PRIVATE_KEY",
      "AUTH_KEY",
      "ACCESS_KEY",
      "SIGNING_KEY",
      "ENCRYPTION_KEY",
      "BEARER",
      "JWT_SECRET",
      "SSH_KEY",
      "PGP_KEY",
      "GPG_KEY",
      "WEBHOOK_SECRET",
      "APP_SECRET",
      "HMAC",
      "SALT",
      "PIN",
      "OTP",
      "MFA_CODE",
      "2FA",
      "TOTP",
      "RECOVERY_CODE",
      "BACKUP_CODE",
    ];
    for (const key of sensitive) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("leaves ordinary keys alone", () => {
    const ordinary = ["LOG_LEVEL", "DB_NAME", "DOCKERIZED", "PUSHOVER_USER", "PORT"];
    for (const key of ordinary) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe("redactConfig", () => {
  it("redacts by key name, by extra key and by Redacted value", () => {
    const redacted = redactConfig(
      {
        DB_NAME: "docstore.db",
        API_KEY: "abc",
        PUSHOVER_TOKEN: Redacted.make("xyz"),
        SESSION: Redacted.make("session"),
        PRIVATE_NOTE: "shh",
        COUNT: 3,
      },
      ["PRIVATE_NOTE"],
    );

    expect(redacted).toEqual({
      DB_NAME: "docstore.db",
      API_KEY: "***",
      PUSHOVER_TOKEN: "***",
      SESSION: "***",
      PRIVATE_NOTE: "***",
      COUNT: 3,
    });
  });

  it("does not mutate the input", () => {
    const config = { API_KEY: "abc", DB_NAME: "docstore.db" };
    redactConfig(config);
    expect(config.API_KEY).toBe("abc");
  });
});

describe("logConfig", () => {
  it.effect("logs the redacted config at info level", () =>
    Effect.gen(function* () {
      yield* logConfig({ DB_NAME: "docstore.db", API_KEY: "abc" });

      const items = yield* Logger.captured;

      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0]!.level, LogLevel.INFO);
      assert.strictEqual(items[0]!.message, "Config:");
      assert.deepStrictEqual(items[0]!.args, [
        { DB_NAME: "docstore.db", API_KEY: "***" },
      ]);
      assert.strictEqual(
        items[0]!.formattedArgs,
        '{"DB_NAME":"docstore.db","API_KEY":"***"}',
      );
    }).pipe(Effect.provide(captureLayer)),
  );
});
