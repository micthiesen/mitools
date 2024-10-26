import { z } from "zod";
import { LogLevel } from "../logging/types.js";

const stringInt = z.string().transform((val) => Number.parseInt(val, 10));
export const baseConfigSchema = z.object({
  PORT: stringInt,
  LOG_LEVEL: z.nativeEnum(LogLevel).optional().default(LogLevel.INFO),
  AUTH_TOKEN: z.string(),
  PUSHOVER_USER: z.string(),
  PUSHOVER_TOKEN: z.string(),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;
