/**
 * Build script for Covel Desktop.
 *
 * Steps:
 *   1. Build the web frontend (pnpm --filter @covel/web build)
 *   2. Bundle main process with esbuild (TS → single ESM file)
 *   3. Copy web-dist + server source to staging area
 *   4. Run electron-builder to create distributable
 */

import { execSync } from "node:child_process";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "../..");

console.log("=== Covel Desktop Build ===\n");

// Step 1: Build web frontend
console.log("[1/4] Building web frontend...");
execSync("pnpm --filter @covel/web build", {
  cwd: projectRoot,
  stdio: "inherit",
});

// Step 2: Bundle main process + preload
console.log("\n[2/4] Bundling main process and preload...");
await build({
  entryPoints: [path.join(desktopRoot, "src/main.ts")],
  bundle: true,
  outfile: path.join(desktopRoot, "dist/main.mjs"),
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  // electron-updater is an optional runtime dependency loaded via dynamic
  // import. Marking it external keeps it out of the main bundle whether or
  // not the package happens to be installed at build time.
  external: ["electron", "electron-updater"],
});

// Preload must be CJS because Electron's contextBridge requires a
// synchronous execution context and CJS avoids ESM loader race conditions
// in the sandbox. Output as .mjs to keep the extension consistent, Electron
// accepts either — the key is the commonjs format.
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

// Step 3: Stage server resources
console.log("\n[3/4] Staging server resources...");
const stagingDir = path.join(desktopRoot, "staging");

// Clean previous staging
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true });
}

const serverStaging = path.join(stagingDir, "server");
const webDistStaging = path.join(stagingDir, "web-dist");

// Copy web dist
const webDistSrc = path.join(projectRoot, "dist/web");
if (!fs.existsSync(webDistSrc)) {
  console.error("ERROR: Web dist not found at", webDistSrc);
  process.exit(1);
}
fs.cpSync(webDistSrc, webDistStaging, { recursive: true });
console.log("  ✓ web-dist copied");

// Copy server essentials (source code, no node_modules)
const serverDirs = [
  "apps/server/src",
  "apps/server/package.json",
  "apps/server/tsconfig.json",
  "packages",
  "plugins",
  "prompts",
  "worlds",
  "tsconfig.json",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
];

for (const entry of serverDirs) {
  const src = path.join(projectRoot, entry);
  const dest = path.join(serverStaging, entry);
  if (!fs.existsSync(src)) {
    console.log(`  ⚠ Skipping ${entry} (not found)`);
    continue;
  }
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Copy llm.toml if present
const llmToml = path.join(projectRoot, "llm.toml");
if (fs.existsSync(llmToml)) {
  fs.copyFileSync(llmToml, path.join(serverStaging, "llm.toml"));
  console.log("  ✓ llm.toml copied");
}

// Install production dependencies in staging
console.log("  Installing server dependencies...");
execSync("pnpm install --frozen-lockfile --prod", {
  cwd: serverStaging,
  stdio: "inherit",
});
console.log("  ✓ server resources staged");

// Step 4: electron-builder
console.log("\n[4/4] Packaging with electron-builder...");
console.log("  Run: pnpm --filter @covel/desktop dist");
console.log("\n=== Build preparation complete ===");
console.log(`\nStaging directory: ${stagingDir}`);
console.log("To create distributable:");
console.log("  pnpm --filter @covel/desktop dist");
