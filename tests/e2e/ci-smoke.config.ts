import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import baseConfig from "../../playwright.config.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const webServer = baseConfig.webServer;

// defineConfig(baseConfig, overrides) concatenates webServer arrays.
export default defineConfig({
  ...baseConfig,
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  outputDir: path.join(repoRoot, "tests/e2e/artifacts/ci-smoke"),
  testMatch: [
    "**/onboarding.spec.ts",
    "**/settings-panels.spec.ts",
    "**/frontend-lifecycle.spec.ts",
  ],
  grep: /first visit starts|saved custom roles remain|debugger navigation opens|browser world edits and cascading deletion/,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.join(repoRoot, "tests/e2e/report/ci-smoke"),
        open: "never",
      },
    ],
  ],
  // A nested config resolves web-server commands from this file's directory.
  webServer: Array.isArray(webServer)
    ? webServer.map((server) => ({ ...server, cwd: repoRoot }))
    : webServer
      ? { ...webServer, cwd: repoRoot }
      : undefined,
});
