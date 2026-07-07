/**
 * Dev script for Covel Desktop.
 *
 * 1. Build main process with esbuild (watch mode)
 * 2. Launch Electron pointing at existing dev servers
 *    (assumes `pnpm dev` is running: web on 5173, server on 3001)
 */

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawnCommand } from "../../../scripts/lib/command-shim.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "../..");

// Build main process + preload
console.log("[dev] Building main process and preload...");
await build({
  entryPoints: [path.join(desktopRoot, "src/main.ts")],
  bundle: true,
  outfile: path.join(desktopRoot, "dist/main.mjs"),
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
});

await build({
  entryPoints: [path.join(desktopRoot, "src/preload.ts")],
  bundle: true,
  outfile: path.join(desktopRoot, "dist/preload.mjs"),
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
});

// Launch Electron
console.log("[dev] Launching Electron...");
console.log("[dev] Make sure 'pnpm dev' is running (web:5173 + server:3001)");

const electron = spawnCommand(
  "pnpm",
  ["exec", "electron", path.join(desktopRoot, "dist/main.mjs")],
  {
    cwd: desktopRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_IS_DEV: "1",
    },
  },
);

electron.on("close", (code) => {
  console.log(`[dev] Electron exited with code ${code}`);
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  electron.kill();
  process.exit(0);
});
