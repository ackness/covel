import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: [
      "./vitest.setup.ts"
    ],
    include: [
      "modules/**/tests/**/*.test.ts",
      "apps/**/tests/**/*.test.ts"
    ]
  }
});
