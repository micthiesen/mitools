import { z } from "zod";
import { LogLevel } from "../logging/types.js";

export const stringBoolean = (value: string): boolean => value.toLowerCase() === "true";
export const baseConfigSchema = z.object({
  LOG_LEVEL: z.nativeEnum(LogLevel).optional().default(LogLevel.INFO),
  PUSHOVER_USER: z.string(),
  PUSHOVER_TOKEN: z.string(),
  DOCKERIZED: z.string().optional().default("false").transform(stringBoolean),
});

const PRIVATE_CONFIG_KEYS: (string & keyof BaseConfig)[] = [
  "PUSHOVER_USER",
  "PUSHOVER_TOKEN",
];
export function logConfig<T extends BaseConfig>(
  config: T,
  extraPrivateConfigKeys: (string & keyof T)[] = [],
): void {
  const privateConfigKeys: Set<string> = new Set([
    ...PRIVATE_CONFIG_KEYS,
    ...extraPrivateConfigKeys,
  ]);

  console.log(
    "Config:",
    Object.fromEntries(
      Object.entries(config).map(([key, value]) => [
        key,
        privateConfigKeys.has(key) ? "***" : value,
      ]),
    ),
  );
}

export type BaseConfig = z.infer<typeof baseConfigSchema>;
