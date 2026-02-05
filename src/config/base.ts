import { z } from "zod";
import { LogLevel } from "../logging/types.js";

export const stringBoolean = (value: string): boolean => value.toLowerCase() === "true";
export const baseConfigSchema = z.object({
  LOG_LEVEL: z.nativeEnum(LogLevel).optional().default(LogLevel.INFO),
  PUSHOVER_USER: z.string(),
  PUSHOVER_TOKEN: z.string(),
  DOCKERIZED: z.string().optional().default("false").transform(stringBoolean),
  DB_NAME: z.string().optional().default("docstore.db"),
});

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

export function logConfig<T extends BaseConfig>(
  config: T,
  extraPrivateConfigKeys: (string & keyof T)[] = [],
): void {
  const explicitPrivateKeys: Set<string> = new Set(extraPrivateConfigKeys);

  console.log(
    "Config:",
    Object.fromEntries(
      Object.entries(config).map(([key, value]) => [
        key,
        explicitPrivateKeys.has(key) || isSensitiveKey(key) ? "***" : value,
      ]),
    ),
  );
}

export type BaseConfig = z.infer<typeof baseConfigSchema>;
