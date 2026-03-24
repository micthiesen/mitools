import type { UserConfig } from "vitest/config";

export const baseVitestConfig: UserConfig = {
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
};
