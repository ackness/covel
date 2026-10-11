import { defineConfig } from "vitest/config";
import { useRunTempDir } from "../../vitest.base.js";

useRunTempDir();

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
