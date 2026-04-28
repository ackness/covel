import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default", "hanging-process"],
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 5_000,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
    },
  },
});
