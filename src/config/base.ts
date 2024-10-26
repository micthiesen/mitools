import { z } from "zod";
import { LogLevel } from "../logging/types.js";

export const baseConfigSchema = z.object({
  LOG_LEVEL: z.nativeEnum(LogLevel).optional().default(LogLevel.INFO),
  PUSHOVER_USER: z.string(),
  PUSHOVER_TOKEN: z.string(),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;
