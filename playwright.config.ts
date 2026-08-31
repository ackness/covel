import { defineConfig, devices } from "@playwright/test";

// Keep the default E2E stack isolated from `pnpm dev`: reusing a long-running
// Vite process can retain a stale dependency-optimization failure, and the
// deterministic browser-checkpoint specs require the browser-private
// MemoryStore profile rather than the normal SQLite development default.
const e2eWebOrigin = "http://127.0.0.1:5181";
const e2eServerOrigin = "http://127.0.0.1:3101";
const baseURL = process.env.E2E_BASE_URL ?? e2eWebOrigin;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./tests/e2e/artifacts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { outputFolder: "tests/e2e/report" }], ["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // An explicit base URL means the caller owns the target environment. The
  // default path starts fresh, dedicated processes and always tears them down.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: "pnpm --filter @covel/server dev",
          env: {
            STORE_BACKEND: "memory",
            SERVER_PORT: "3101",
            CORS_ORIGIN: e2eWebOrigin,
          },
          url: `${e2eServerOrigin}/api/health`,
          reuseExistingServer: false,
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
          timeout: 60_000,
        },
        {
          command:
            "pnpm --filter @covel/web dev --host 127.0.0.1 --port 5181 --strictPort",
          env: { RUNTIME_PORT: "3101" },
          url: e2eWebOrigin,
          reuseExistingServer: false,
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
          timeout: 60_000,
        },
      ],
});
