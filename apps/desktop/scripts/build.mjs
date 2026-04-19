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

// Copy web dist
const webDistSrc = path.join(projectRoot, "dist/web");
if (!fs.existsSync(webDistSrc)) {
  console.error("ERROR: Web dist not found at", webDistSrc);
  process.exit(1);
}
fs.cpSync(webDistSrc, webDistStaging, { recursive: true });
console.log("  ✓ web-dist copied");

// `pnpm deploy` 创建 standalone 部署目录。--legacy 走复制语义（默认 2026+ 版
// 已支持），--prod 剔除 devDeps，--filter 锁定目标 workspace 包。
// 目录是独立的（无 pnpm-workspace.yaml），node_modules 扁平放置。
execSync(
  `pnpm --filter @covel/server deploy --prod --legacy "${serverStaging}"`,
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);
console.log("  ✓ pnpm deploy → staging/server/");

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
console.log("  ✓ server resources staged");

// Step 4: electron-builder
console.log("\n[4/4] Packaging with electron-builder...");
console.log("  Run: pnpm --filter @covel/desktop dist");
console.log("\n=== Build preparation complete ===");
console.log(`\nStaging directory: ${stagingDir}`);
console.log("To create distributable:");
console.log("  pnpm --filter @covel/desktop dist");
