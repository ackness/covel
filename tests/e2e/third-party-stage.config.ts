import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const webOrigin = "http://127.0.0.1:5182";
const serverOrigin = "http://127.0.0.1:3102";
const home = mkdtempSync(join(tmpdir(), "covel-community-stage-"));
const plugins = join(home, "plugins");
mkdirSync(plugins);
mkdirSync(join(home, "worlds"));
cpSync(
  resolve(import.meta.dirname, "test-assets/community-stage-proof"),
  join(plugins, "community-stage-proof"),
  { recursive: true },
);
// `home` is always a new mkdtemp-owned directory, never a user profile.
process.once("exit", () => rmSync(home, { recursive: true, force: true }));

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "**/*.acceptance.ts",
  outputDir: resolve(import.meta.dirname, "artifacts/extensions"),
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: webOrigin,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @covel/server dev",
      env: {
        STORE_BACKEND: "memory",
        SERVER_PORT: "3102",
        CORS_ORIGIN: webOrigin,
        COVEL_HOME: home,
        COVEL_USER_PLUGINS_DIR: plugins,
        COVEL_SERVER_LOG_FILE: "",
        SQLITE_PATH: join(home, "data", "covel.db"),
      },
      url: `${serverOrigin}/api/health`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: 60_000,
    },
    {
      command:
        "pnpm --filter @covel/web dev --host 127.0.0.1 --port 5182 --strictPort",
      env: { RUNTIME_PORT: "3102" },
      url: webOrigin,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: 60_000,
    },
  ],
});
