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
import { rebuild as electronRebuild } from "@electron/rebuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { ensureElectronBinary } from "./ensure-electron.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "../..");

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
const webDistPath = path.join(projectRoot, "dist/web");
if (fs.existsSync(webDistPath)) {
  console.log(
    "  ✓ dist/web already built — skipping (turbo build already produced it)",
  );
} else {
  execSync("pnpm --filter @covel/web build", {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

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
  external: ["electron"],
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

// Step 3: Stage server resources via `pnpm deploy`.
//
// 背景：electron-builder 对 pnpm 的 isolated node_modules（软链 + .pnpm/）
// 支持非常差——打 asar 时会 stat 断链的 symlink 报 ENOENT。hoisted 模式
// 也不行，因为 apps/server/node_modules 下仍只有 @covel/* 的包内软链。
//
// 方案：`pnpm deploy` 生成一个完全独立、扁平的可部署目录，把 workspace
// 包和 npm 包一起拷贝进去（所有 @covel/* 变成真实文件夹而非软链），
// electron-builder 打包时不再触碰 workspace 体系。
console.log("\n[3/4] Staging server resources (pnpm deploy)...");
const stagingDir = path.join(desktopRoot, "staging");

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

// Plugins' handler.js / guard.js import workspace packages that are NOT in
// @covel/server's dependency tree — e.g. @covel/plugin-handlers-utils is used
// only by plugin handlers, never by the server. `pnpm deploy --filter
// @covel/server` therefore omits them, and the staged plugins fail to load at
// runtime with ERR_MODULE_NOT_FOUND. Collect every @covel/* runtime dep
// declared by a bundled plugin (plus their transitive @covel deps) and copy any
// the server deploy didn't already provide.
function ensurePluginWorkspaceDeps() {
  const nodeModulesDir = path.join(serverStaging, "node_modules");
  const pluginsDir = path.join(projectRoot, "plugins");
  if (!fs.existsSync(pluginsDir)) return;

  const covelDepsOf = (pkgJsonPath) => {
    if (!fs.existsSync(pkgJsonPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    // Runtime deps only — devDependencies (e.g. @covel/plugin-test-utils) never
    // load in the packaged sidecar.
    return Object.keys(pkg.dependencies ?? {}).filter((name) =>
      name.startsWith("@covel/"),
    );
  };

  // @covel/* are workspace packages — resolve to their source dir. A package
  // depended on ONLY by plugins (e.g. @covel/plugin-handlers-utils) has no
  // root/server node_modules symlink, so resolveInstalledPackagePath misses it;
  // the source under packages/<name> (or apps/<name>) is the reliable origin.
  const resolveWorkspaceSource = (name) => {
    const short = name.slice("@covel/".length);
    for (const dir of ["packages", "apps"]) {
      const candidate = path.join(projectRoot, dir, short);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    return resolveInstalledPackagePath(name);
  };

  const SKIP = new Set(["node_modules", "dist", ".turbo", "coverage", "tests"]);

  const queue = [];
  for (const entry of fs.readdirSync(pluginsDir)) {
    queue.push(...covelDepsOf(path.join(pluginsDir, entry, "package.json")));
  }

  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const source = resolveWorkspaceSource(name);
    if (!source) {
      console.warn(`  ⚠ plugin workspace dep not resolvable: ${name}`);
      continue;
    }
    // Follow this package's own @covel deps so transitive ones are staged too.
    queue.push(...covelDepsOf(path.join(source, "package.json")));

    const target = path.join(nodeModulesDir, ...name.split("/"));
    if (fs.existsSync(target)) continue; // server deploy already provided it
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(fs.realpathSync(source), target, {
      recursive: true,
      filter: (src) => !SKIP.has(path.basename(src)),
    });
    console.log(`  ✓ staged plugin workspace dep: ${name}`);
  }
}

async function rebuildNativeForElectron(stagingDir) {
  const electronPkgPath = path.join(
    desktopRoot,
    "node_modules/electron/package.json",
  );
  if (!fs.existsSync(electronPkgPath)) {
    throw new Error(
      `Cannot locate electron package to derive ABI version: ${electronPkgPath}`,
    );
  }
  const electronVersion = JSON.parse(
    fs.readFileSync(electronPkgPath, "utf-8"),
  ).version;
  console.log(`  Electron ${electronVersion} ABI target`);

  await electronRebuild({
    buildPath: stagingDir,
    electronVersion,
    onlyModules: ["better-sqlite3"],
    force: true,
  });
}

function verifyStagedServerRuntime() {
  const checks = [
    path.join(serverStaging, "src/index.ts"),
    path.join(serverStaging, "node_modules/tsx/dist/cli.mjs"),
    path.join(serverStaging, "node_modules/esbuild/package.json"),
  ];
  const missing = checks.filter((target) => !fs.existsSync(target));
  if (missing.length > 0) {
    throw new Error(
      `Desktop server staging is incomplete:\n${missing.map((p) => `- ${p}`).join("\n")}`,
    );
  }

  const esbuildScopeDir = path.join(serverStaging, "node_modules/@esbuild");
  const hasPlatformBinary =
    fs.existsSync(esbuildScopeDir) &&
    fs
      .readdirSync(esbuildScopeDir)
      .some(
        (name) =>
          name.startsWith("darwin-") ||
          name.startsWith("win32-") ||
          name.startsWith("linux-"),
      );
  if (!hasPlatformBinary) {
    throw new Error(
      `Desktop server staging is missing @esbuild platform packages in ${esbuildScopeDir}`,
    );
  }
}

// Copy web dist
const webDistSrc = path.join(projectRoot, "dist/web");
if (!fs.existsSync(webDistSrc)) {
  console.error("ERROR: Web dist not found at", webDistSrc);
  process.exit(1);
}
fs.cpSync(webDistSrc, webDistStaging, { recursive: true });
console.log("  ✓ web-dist copied");

// `pnpm deploy` 创建 standalone 部署目录。
// - --filter 锁定目标 workspace 包
// - --prod 剔除 devDeps
// - --legacy 走复制语义（2026+ 默认开启 dedicated-lockfile，用 --legacy 关掉）
// - --config.node-linker=hoisted 让 node_modules 里全是真实文件夹而非
//   .pnpm/ 软链（默认 isolated 模式下 node_modules/tsx → .pnpm/tsx@X.Y/...
//   这种软链 macOS 可用，Windows 上 electron-builder 复制 extraResources
//   时会断链，导致打包后 resources/server/node_modules/tsx 不存在）。
execSync(
  `pnpm --filter @covel/server deploy --prod --legacy --config.node-linker=hoisted "${serverStaging}"`,
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);
console.log("  ✓ pnpm deploy → staging/server/ (hoisted)");

// pnpm deploy on workspaces still shows cross-platform gaps around hoisted
// runtime packages. Restore the critical tsx/esbuild tree explicitly so the
// packaged app always has a bootable server sidecar.
ensureRuntimePackages();

// Plugins import workspace packages outside @covel/server's dependency tree
// (e.g. @covel/plugin-handlers-utils) — stage them so handler/guard imports
// resolve in the packaged sidecar instead of ERR_MODULE_NOT_FOUND.
ensurePluginWorkspaceDeps();

// 拷贝 server 运行所需的仓库级资源（这些不在 @covel/server 依赖图里）。
// 注意：plugins/*/node_modules 来自 pnpm workspace 安装，内部是层层嵌套的
// 软链（含 typescript lib 等大量文件），electron-builder 扫描时会撑爆
// macOS 的 fd 上限（EMFILE）。一律剔除以下噪声目录。
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".turbo",
  "dist",
  "coverage",
  ".cache",
  "tests",
  "__tests__",
]);
const sideCarResources = ["plugins", "prompts", "worlds"];
for (const entry of sideCarResources) {
  const src = path.join(projectRoot, entry);
  const dest = path.join(serverStaging, entry);
  if (!fs.existsSync(src)) {
    console.log(`  ⚠ Skipping ${entry} (not found)`);
    continue;
  }
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => !EXCLUDE_DIRS.has(path.basename(source)),
  });
}
console.log("  ✓ plugins/prompts/worlds copied (node_modules/dist excluded)");

// Copy llm.toml if present
const llmToml = path.join(projectRoot, "llm.toml");
if (fs.existsSync(llmToml)) {
  fs.copyFileSync(llmToml, path.join(serverStaging, "llm.toml"));
  console.log("  ✓ llm.toml copied");
}
verifyStagedServerRuntime();
console.log("  ✓ server runtime verified");
console.log("  ✓ server resources staged");

// Step 3b: rebuild native addons against the Electron Node ABI so they load
// inside the Electron main process at runtime. Electron 40 has
// NODE_MODULE_VERSION 143; a CI-default Node 24 bakes 137 into
// better_sqlite3.node and we get ERR_DLOPEN_FAILED on first use.
console.log("\n[3b/4] Rebuilding native addons for Electron ABI...");
await rebuildNativeForElectron(serverStaging);
console.log("  ✓ native addons rebuilt for Electron");

// Step 3c: smoke-test the staged server so electron-builder never wraps a
// known-broken sidecar. Run it under Electron's Node mode because the packaged
// app launches the sidecar with process.execPath + ELECTRON_RUN_AS_NODE.
// The runtime binary must be materialised first — electron@42+ no longer
// downloads it on install (see ensure-electron.mjs).
ensureElectronBinary();
console.log("\n[3c/4] Smoke-testing staged server (with llm.toml)...");
execSync(
  `node "${path.join(desktopRoot, "scripts/verify-staging.mjs")}" --electron-node`,
  {
    cwd: desktopRoot,
    stdio: "inherit",
  },
);
console.log("\n[3c/4] Smoke-testing staged server (without llm.toml)...");
execSync(
  `node "${path.join(desktopRoot, "scripts/verify-staging.mjs")}" --electron-node --no-llm-toml`,
  {
    cwd: desktopRoot,
    stdio: "inherit",
  },
);

// Step 4: electron-builder
console.log("\n[4/4] Packaging with electron-builder...");
console.log("  Run: pnpm --filter @covel/desktop dist");
console.log("\n=== Build preparation complete ===");
console.log(`\nStaging directory: ${stagingDir}`);
console.log("To create distributable:");
console.log("  pnpm --filter @covel/desktop dist");
