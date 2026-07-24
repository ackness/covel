import { defineConfig, devices } from "@playwright/test";

// `pnpm dev` serves the web SPA from Vite (5173) and proxies `/api/*` to the
// runtime server (3001). The server itself only serves the built SPA when
// SERVE_STATIC is set (production/Docker), so in dev every page route on 3001
// is a bare 404 — point page navigation at Vite. API-only tests use relative
// `/api/*` paths, which Vite proxies to 3001. Override via E2E_BASE_URL when
// running against a served-static build (e.g. the Docker stack).
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

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
  /* Start the Docker stack before tests if not already running */
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:3001/api/health",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
