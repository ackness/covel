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
// The installable example under tests/third-party/, exercised as a player
// would meet it: a community package the session has to approve.
cpSync(
  resolve(import.meta.dirname, "../third-party/clickable-map"),
  join(plugins, "clickable-map"),
  { recursive: true },
);
cpSync(
  resolve(import.meta.dirname, "../third-party/declarative-notebook"),
  join(plugins, "declarative-notebook"),
  { recursive: true },
);
cpSync(
  resolve(import.meta.dirname, "../third-party/sandbox-surface-probe"),
  join(plugins, "sandbox-surface-probe"),
  { recursive: true },
);
// `home` is always a new mkdtemp-owned directory, never a user profile.
process.once("exit", () => rmSync(home, { recursive: true, force: true }));

export default defineConfig({
  metadata: {
    declarativeNotebookRoot: join(plugins, "declarative-notebook"),
    sandboxProbeRoot: join(plugins, "sandbox-surface-probe"),
  },
  testDir: import.meta.dirname,
  testMatch: "**/*.acceptance.ts",
  outputDir: resolve(import.meta.dirname, "artifacts/extensions"),
  forbidOnly: !!process.env.CI,
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: { timeout: process.env.CI ? 10_000 : 5_000 },
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: resolve(import.meta.dirname, "report/extensions"),
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: webOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Fixture upgrades import temporary modules. Watching those modules would
      // restart the memory-backed API during the next test's session setup.
      command:
        "pnpm --filter @covel/server exec tsx --import=../../scripts/ensure-plugin-sdk.mjs src/index.ts",
      env: {
        NODE_ENV: "development",
        STORE_BACKEND: "memory",
        SERVER_PORT: "3102",
        CORS_ORIGIN: webOrigin,
        COVEL_HOME: home,
        COVEL_USER_PLUGINS_DIR: plugins,
        COVEL_SERVER_LOG_FILE: "",
        // The job worker runs a queued job only when its model has
        // credentials. Nothing here calls a model, so a placeholder is enough
        // for the function runtimes that event jobs execute.
        DEEPSEEK_API_KEY: "acceptance-placeholder",
        SQLITE_PATH: join(home, "data", "covel.db"),
      },
      url: `${serverOrigin}/api/health`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: process.env.CI ? 120_000 : 60_000,
    },
    {
      command:
        "pnpm --filter @covel/web e2e:serve --host 127.0.0.1 --port 5182",
      env: { RUNTIME_PORT: "3102" },
      url: webOrigin,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: process.env.CI ? 180_000 : 120_000,
    },
  ],
});
