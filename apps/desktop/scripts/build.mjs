/**
 * Build script for Covel Desktop.
 *
 * Steps:
 *   1. Build the web frontend (pnpm --filter @covel/web build)
 *   2. Bundle main process with esbuild (TS → single ESM file)
 *   3. Copy web-dist and precompile server/workspace modules in staging
 *   4. Verify the staged backend with and without configuration
 *
 * Packaging runs separately through the pack/dist scripts or release workflow.
 */

import { execFileSync, execSync } from "node:child_process";
import { bundleDesktopEntry } from "./bundle-desktop.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { ensureElectronBinary } from "./ensure-electron.mjs";
import {
  assertDesktopBundle,
  detachStagingHardlinks,
  isGalleryOriginal,
  pruneStagedServer,
  verifyBundledNotices,
} from "./staging-files.mjs";
import { compileStagedServer } from "./compile-server.mjs";
import { assertMainBundle } from "./main-bundle.mjs";
import {
  BACKEND_RUNTIME_MODE,
  probeBackendRuntime,
  stageBackendRuntime,
  writeRuntimeBundleSelection,
} from "./backend-runtime.mjs";
import { verifyTargetNativePackages } from "./before-pack.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "../..");

// Check the actual runtime before building backend artifacts. Cross targets
// are checked again by their packaged main process at launch.
await probeBackendRuntime(ensureElectronBinary(), {
  platform: process.platform,
  arch: process.arch,
});

console.log("=== Covel Desktop Build ===\n");

// Step 1: Build web frontend
//
// @covel/desktop now declares a workspace dependency on @covel/web
// (package.json), so `turbo build` already sequences web's build before
// this script runs — building it again here would race turbo's own build
// against the same `dist/web` output dir (both use vite's emptyOutDir).
// Standalone invocations (`pnpm build:electron` / `pnpm --filter
// @covel/desktop dist`, which bypass turbo) still need this fallback.
console.log("[1/4] Building web frontend...");
// H-10: NEVER gate on existsSync(dist/web) — a stale dir from an old frontend
// would be packaged silently. Standalone builds (`pnpm build:electron`,
// `pnpm --filter @covel/desktop dist`) bypass turbo's freshness graph, so they
// must ALWAYS rebuild. The only safe skip is when turbo itself drives the build:
// the @covel/web#build task is sequenced first via the workspace dep, so
// dist/web is already fresh. Turbo sets TURBO_HASH in every in-task env — use
// that explicit signal, not directory existence.
const webDistPath = path.join(projectRoot, "dist/web");
const underTurbo = Boolean(process.env.TURBO_HASH);
if (underTurbo && fs.existsSync(webDistPath)) {
  console.log(
    "  ✓ dist/web produced by turbo this run (fresh) — skipping rebuild",
  );
} else {
  execSync("pnpm --filter @covel/web build", {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

// Step 2: Bundle main process + preload
console.log("\n[2/4] Bundling main process and preload...");
const bundleOptions = { metafile: true, legalComments: "inline" };
const mainBundle = await bundleDesktopEntry(desktopRoot, "main", bundleOptions);
assertDesktopBundle(mainBundle.metafile);
const mainFile = path.join(desktopRoot, "dist/main.mjs");
assertMainBundle(fs.readFileSync(mainFile, "utf8"), mainFile);

const preloadBundle = await bundleDesktopEntry(
  desktopRoot,
  "preload",
  bundleOptions,
);
assertDesktopBundle(preloadBundle.metafile);
writeRuntimeBundleSelection(desktopRoot);

// Step 3: Stage server resources via `pnpm deploy`.
//
// Background: electron-builder handles pnpm's isolated node_modules (symlinks
// into .pnpm/) poorly and fails with ENOENT when packaging symlinks into ASAR;
// hoisted workspace installs still leave @covel/* workspace symlinks.
//
// Approach: `pnpm deploy` produces a self-contained flat staging directory with
// real directories for every @covel/* workspace package and npm dependency so
// electron-builder never touches the monorepo workspace layout.
console.log("\n[3/4] Staging server resources (pnpm deploy)...");
const stagingDir = path.join(desktopRoot, "staging");
const bundledModelDb = path.join(
  projectRoot,
  "packages/ai-provider/data/model-db.json",
);

// Release builds use a committed snapshot generated from a fixed LiteLLM
// revision. Builds never fetch mutable upstream data; maintainers update the
// snapshot explicitly with the package's update-model-db task.
if (!fs.existsSync(bundledModelDb)) {
  throw new Error(
    `Committed model database snapshot is missing: ${bundledModelDb}`,
  );
}

// Clean previous staging
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true });
}

const serverStaging = path.join(stagingDir, "server");
const webDistStaging = path.join(stagingDir, "web-dist");

function copyIfMissing(source, target) {
  if (fs.existsSync(target) || !fs.existsSync(source)) {
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(fs.realpathSync(source), target, { recursive: true });
}

function resolveInstalledPackagePath(packageName) {
  const segments = packageName.split("/");
  const candidates = [
    path.join(projectRoot, "apps/server/node_modules", ...segments),
    path.join(projectRoot, "node_modules", ...segments),
    path.join(projectRoot, "apps/desktop/node_modules", ...segments),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.realpathSync(candidate);
    }
  }
  return null;
}

function ensureRuntimePackages() {
  const nodeModulesDir = path.join(serverStaging, "node_modules");
  const requiredPackages = ["tsx", "esbuild"];

  for (const packageName of requiredPackages) {
    const target = path.join(nodeModulesDir, ...packageName.split("/"));
    if (fs.existsSync(target)) continue;

    const source = resolveInstalledPackagePath(packageName);
    if (!source) {
      throw new Error(`Required runtime package not installed: ${packageName}`);
    }
    copyIfMissing(source, target);
    console.log(`  ✓ restored missing runtime package: ${packageName}`);
  }

  const esbuildScopeSource = resolveInstalledPackagePath("@esbuild");
  const esbuildScopeTarget = path.join(nodeModulesDir, "@esbuild");
  if (!fs.existsSync(esbuildScopeTarget) && esbuildScopeSource) {
    copyIfMissing(esbuildScopeSource, esbuildScopeTarget);
    console.log("  ✓ restored missing runtime package scope: @esbuild");
  }
}

function verifyStagedServerRuntime() {
  const checks = [
    path.join(serverStaging, "src/index.js"),
    path.join(serverStaging, "node_modules/tsx/dist/loader.mjs"),
    path.join(serverStaging, "node_modules/esbuild/package.json"),
    path.join(
      serverStaging,
      "node_modules/@covel/ai-provider/data/model-db.json",
    ),
    // Plugins import the author SDK and zod through the host: plugin-loader
    // resolves them for every plugin, bundled or installed.
    path.join(
      serverStaging,
      "node_modules/@covel/plugin-handlers-utils/dist/index.js",
    ),
    path.join(serverStaging, "node_modules/zod/package.json"),
  ];
  const missing = checks.filter((target) => !fs.existsSync(target));
  if (missing.length > 0) {
    throw new Error(
      `Desktop server staging is incomplete:\n${missing.map((p) => `- ${p}`).join("\n")}`,
    );
  }

  const stagedModelDbPath = checks[3];
  let stagedModelDb;
  try {
    stagedModelDb = JSON.parse(fs.readFileSync(stagedModelDbPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Desktop model database snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stagedModelCount = Object.keys(stagedModelDb.models ?? {}).length;
  if (stagedModelDb.count !== stagedModelCount || stagedModelCount === 0) {
    throw new Error(
      `Desktop model database snapshot is inconsistent (${stagedModelDb.count ?? "missing"} declared, ${stagedModelCount} entries)`,
    );
  }

  verifyTargetNativePackages(serverStaging, {
    platform: process.platform,
    arch: process.arch,
  });
}

// Copy web dist
const webDistSrc = path.join(projectRoot, "dist/web");
if (!fs.existsSync(webDistSrc)) {
  console.error("ERROR: Web dist not found at", webDistSrc);
  process.exit(1);
}
fs.cpSync(webDistSrc, webDistStaging, { recursive: true });
console.log("  ✓ web-dist copied");

// `pnpm deploy` creates a standalone staging tree:
// - --filter selects the target workspace package
// - --prod omits devDependencies
// - --config.inject-workspace-packages=true enables workspace package copying
//   so workspace deps (e.g. @covel/store) and their transitive deps (e.g.
//   sqlite-vec) are copied into staging instead of leaving empty node_modules.
// - --ignore-scripts skips install scripts during deploy; esbuild platform
//   packages are explicitly ensured below by ensureRuntimePackages.
// - --config.node-linker=hoisted materializes real directories instead of
//   .pnpm/ symlinks, which break when electron-builder copies extraResources
//   on Windows (leaving resources/server/node_modules/tsx missing).
// Linux packages both x64 and arm64 from one staging tree. Limit this optional
// dependency expansion to deploy, leaving native macOS/Windows installs alone.
const deployArchitectures =
  process.platform === "linux"
    ? `'--config.supportedArchitectures=["linux-x64","linux-arm64"]'`
    : "";
execSync(
  `pnpm --filter @covel/server deploy --prod --ignore-scripts --config.node-linker=hoisted --config.inject-workspace-packages=true ${deployArchitectures} "${serverStaging}"`,
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);
console.log("  ✓ pnpm deploy → staging/server/ (hoisted)");

// Cache restoration writes into existing output files. Detach pnpm's hardlinks
// before any staged-file rewrite, so neither those writes nor a later cache
// hit can roll workspace sources or the pnpm package store back to old bytes.
const detachedFiles = detachStagingHardlinks(serverStaging);
console.log(`  ✓ detached ${detachedFiles} shared staging file(s)`);

// pnpm deploy on workspaces still shows cross-platform gaps around hoisted
// runtime packages. Restore the critical tsx/esbuild tree explicitly so the
// packaged app always has a bootable server sidecar.
ensureRuntimePackages();

// Plugins import workspace packages outside @covel/server's dependency tree
// (e.g. @covel/plugin-handlers-utils) — stage them so handler/guard imports
// resolve in the packaged sidecar instead of ERR_MODULE_NOT_FOUND.

// Copy the committed snapshot explicitly so workspace packlist differences do
// not remove the baseline database from an installer.
const stagedModelDb = path.join(
  serverStaging,
  "node_modules/@covel/ai-provider/data/model-db.json",
);
fs.mkdirSync(path.dirname(stagedModelDb), { recursive: true });
fs.copyFileSync(bundledModelDb, stagedModelDb);
console.log("  ✓ bundled model database staged");

// Copy repo-level resources needed by the server (not part of @covel/server's
// dependency graph). Exclude nested workspace/test noise dirs such as
// plugins/*/node_modules (deep pnpm symlinks can hit macOS EMFILE during
// electron-builder scanning).
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".turbo",
  "dist",
  "coverage",
  ".cache",
  "tests",
  "__tests__",
]);
const sideCarResources = ["plugins", "prompts", "worlds", "packs"];
for (const entry of sideCarResources) {
  const src = path.join(projectRoot, entry);
  const dest = path.join(serverStaging, entry);
  if (!fs.existsSync(src)) {
    console.log(`  ⚠ Skipping ${entry} (not found)`);
    continue;
  }
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      if (EXCLUDE_DIRS.has(base)) return false;
      // Top-level `_` dirs are not packages: never loaded at runtime, dead
      // weight in the app.
      if (base.startsWith("_") && path.dirname(source) === src) return false;
      if (entry === "worlds" && isGalleryOriginal(source)) return false;
      return true;
    },
  });
}
console.log("  ✓ plugins/prompts/worlds copied (node_modules/dist excluded)");

const compiledModules = await compileStagedServer(serverStaging);
console.log(
  `  ✓ precompiled ${compiledModules.length} server/workspace modules`,
);
pruneStagedServer(serverStaging, compiledModules);
verifyBundledNotices(
  [mainBundle.metafile, preloadBundle.metafile],
  desktopRoot,
  serverStaging,
);
console.log("  ✓ pruned reviewed development files; bundled notices verified");

// User configuration belongs to the installed app's data directory. Never
// copy the developer's llm.toml into distributable resources or Turbo caches.
verifyStagedServerRuntime();
console.log("  ✓ server runtime verified");
console.log("  ✓ server resources staged");

// Bind this target's runtime metadata to the freshly bundled main process.
await stageBackendRuntime(desktopRoot, {
  platform: process.platform,
  arch: process.arch,
});
console.log(
  `\n[4/4] Smoke-testing ${BACKEND_RUNTIME_MODE} backend + SQLite (with synthetic config)...`,
);
execFileSync(process.execPath, [path.join(__dirname, "verify-staging.mjs")], {
  cwd: desktopRoot,
  stdio: "inherit",
});
console.log(
  `\n[4/4] Smoke-testing ${BACKEND_RUNTIME_MODE} backend + SQLite (without llm.toml)...`,
);
execFileSync(
  process.execPath,
  [path.join(__dirname, "verify-staging.mjs"), "--no-llm-toml"],
  { cwd: desktopRoot, stdio: "inherit" },
);

console.log("\n=== Build preparation complete ===");
console.log(`\nStaging directory: ${stagingDir}`);
console.log("To create distributable:");
console.log("  pnpm --filter @covel/desktop dist");
