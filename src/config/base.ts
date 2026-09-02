import { Config, Effect, Redacted } from "effect";
import { LogLevel } from "../logging/types.js";

/** Parses the strings "true"/"false" (case-insensitive) the way `DOCKERIZED` used to. */
export const stringBoolean = (value: string): boolean => value.toLowerCase() === "true";

/**
 * The environment variables every mitools consumer shares. Spread these into
 * your own `Config.all({...baseConfigFields, MY_KEY: Config.string("MY_KEY")})`.
 *
 * The library's services read what they need themselves (`Sqlite.layerConfig`,
 * `Logger.layerConfig`, `Pushover.layerConfig`), so this exists for consumers
 * that want one typed config object at startup.
 */
export const baseConfigFields = {
  LOG_LEVEL: Config.literals(
    [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR],
    "LOG_LEVEL",
  ).pipe(Config.withDefault(LogLevel.INFO)),
  PUSHOVER_USER: Config.string("PUSHOVER_USER").pipe(Config.withDefault(undefined)),
  PUSHOVER_TOKEN: Config.redacted("PUSHOVER_TOKEN").pipe(Config.withDefault(undefined)),
  DOCKERIZED: Config.string("DOCKERIZED").pipe(
    Config.map(stringBoolean),
    Config.withDefault(false),
  ),
  DB_NAME: Config.string("DB_NAME").pipe(Config.withDefault("docstore.db")),
};

export const baseConfig = Config.all(baseConfigFields);

export type BaseConfig = Config.Success<typeof baseConfig>;

const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /private[_-]?key/i,
  /auth[_-]?key/i,
  /access[_-]?key/i,
  /client[_-]?secret/i,
  /signing[_-]?key/i,
  /encryption[_-]?key/i,
  /bearer/i,
  /jwt/i,
  /ssh[_-]?key/i,
  /pgp/i,
  /gpg/i,
  /webhook[_-]?secret/i,
  /api[_-]?secret/i,
  /app[_-]?secret/i,
  /hmac/i,
  /salt/i,
  /pin/i,
  /otp/i,
  /mfa/i,
  /2fa/i,
  /totp/i,
  /recovery[_-]?code/i,
  /backup[_-]?code/i,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** A copy of `config` with sensitive keys (by name) and `Redacted` values replaced by "***". */
export function redactConfig<T extends object>(
  config: T,
  extraPrivateConfigKeys: (string & keyof T)[] = [],
): Record<string, unknown> {
  const explicitPrivateKeys: Set<string> = new Set(extraPrivateConfigKeys);
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      explicitPrivateKeys.has(key) || isSensitiveKey(key) || Redacted.isRedacted(value)
        ? "***"
        : value,
    ]),
  );
}

/** Logs the config at info level with sensitive keys redacted. */
export function logConfig<T extends object>(
  config: T,
  extraPrivateConfigKeys: (string & keyof T)[] = [],
): Effect.Effect<void> {
  return Effect.logInfo("Config:", redactConfig(config, extraPrivateConfigKeys));
}
