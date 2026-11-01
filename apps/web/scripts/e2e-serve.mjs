#!/usr/bin/env node
/**
 * e2e-serve — build the app as players get it and serve it for Playwright.
 *
 * `playwright.config.ts` starts this next to the Vite dev server. Specs that
 * import the app's own modules in the page need the dev server; every other
 * spec runs against this build. A fresh browser context loads the dev server's
 * hundreds of separate modules on every page, and one Vite process serves them
 * all, so the suite waited on it instead of running in parallel.
 *
 * The build goes to dist/web-e2e, never over a packaged build in dist/web,
 * and is a production build even when the shell or `.env` says otherwise.
 *
 *   node scripts/e2e-serve.mjs [--host 127.0.0.1] [--port 5183]
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import { spawnCommand } from "../../../scripts/lib/command-shim.mjs";

const { values } = parseArgs({
  options: {
    "build-only": { type: "boolean", default: false },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "5183" },
  },
});
process.env.NODE_ENV = "production";
const outDir = fileURLToPath(new URL("../../../dist/web-e2e", import.meta.url));

if (values["build-only"]) {
  await build({ logLevel: "warn", build: { outDir, emptyOutDir: true } });
  process.exit(0);
}

// Content-addressed output, rather than an existence check: edits invalidate
// the build, while smoke/acceptance/stress can serve the same fresh bundle.
const status = await new Promise((resolve, reject) => {
  const child = spawnCommand(
    "pnpm",
    ["exec", "turbo", "build:e2e", "--filter=@covel/web"],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      stdio: "inherit",
    },
  );
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
if (status !== 0) process.exit(status);
const server = await preview({
  build: { outDir },
  preview: { host: values.host, port: Number(values.port), strictPort: true },
});
server.printUrls();
