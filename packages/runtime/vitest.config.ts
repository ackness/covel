import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "../../plugins-v2/**/tests/**/*.test.ts",
    ],
  },
});
