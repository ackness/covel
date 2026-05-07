/**
 * Copy Tauri bundle artefacts from the cargo target dir into the
 * repo-level `release/tauri/<target>/` so Electron and Tauri outputs
 * live side by side:
 *
 *   release/
 *     electron/       ← electron-builder output
 *     tauri/
 *       aarch64-apple-darwin/
 *         Covel_0.0.1-beta_aarch64.dmg
 *         Covel.app (tarball or dir)
 *
 * Invocation:
 *   node scripts/stage-release.mjs <target-triple>
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopTauriRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopTauriRoot, "../..");
const target = process.argv[2];

if (!target) {
  console.error("[stage-release] usage: stage-release.mjs <target-triple>");
  process.exit(1);
}

const bundleDir = path.join(
  desktopTauriRoot,
  "src-tauri/target",
  target,
  "release/bundle",
);
if (!(await exists(bundleDir))) {
  console.error(`[stage-release] bundle missing at ${bundleDir}`);
  process.exit(1);
}

const destDir = path.join(repoRoot, "release/tauri", target);
await fs.rm(destDir, { recursive: true, force: true });
await fs.mkdir(destDir, { recursive: true });

// Whitelist distributable artefacts. Anything Tauri dumps into bundle/
// that isn't one of these (bundle_dmg.sh, create-dmg/, icon.icns, …) is
// build scaffolding and gets skipped.
const FILE_EXTS = new Set([
  ".dmg",
  ".zip",
  ".msi",
  ".exe",
  ".deb",
  ".rpm",
  ".appimage",
  ".tar.gz",
]);
const isDistFile = (name) => {
  const lower = name.toLowerCase();
  for (const ext of FILE_EXTS) if (lower.endsWith(ext)) return true;
  return false;
};
const isAppBundle = (name) => name.endsWith(".app");

// Insert "-tauri-" after the product name in each staged filename so
// Tauri outputs never collide with Electron outputs in release/. The
// productName itself stays "Covel" (visible to users).
//
//   Covel_0.0.1-beta_aarch64.dmg         →  Covel-tauri-0.0.1-beta_aarch64.dmg
//   Covel_0.0.1-beta_x64-setup.exe       →  Covel-tauri-0.0.1-beta_x64-setup.exe
//   Covel.app                            →  Covel-tauri.app
function renameForTauri(name) {
  if (name === "Covel.app") return "Covel-tauri.app";
  return name.replace(/^Covel([_-])/, "Covel-tauri$1");
}

const kindDirs = await fs.readdir(bundleDir, { withFileTypes: true });
const copied = [];
for (const kind of kindDirs) {
  if (!kind.isDirectory()) continue;
  const kindPath = path.join(bundleDir, kind.name);
  for (const entry of await fs.readdir(kindPath, { withFileTypes: true })) {
    if (entry.isDirectory() && !isAppBundle(entry.name)) continue;
    if (!entry.isDirectory() && !isDistFile(entry.name)) continue;
    const src = path.join(kindPath, entry.name);
    const dest = path.join(destDir, renameForTauri(entry.name));
    await copyAny(src, dest);
    copied.push(path.relative(repoRoot, dest));
  }
}

console.log("[stage-release] staged:");
for (const p of copied) console.log(`  ${p}`);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyAny(src, dest) {
  const stat = await fs.lstat(src);
  if (stat.isDirectory()) {
    // .app bundle or similar — use system cp -a to preserve symlinks/perms.
    if (process.platform === "win32") {
      execSync(`xcopy "${src}" "${dest}" /E /I /Y /Q`, { stdio: "inherit" });
    } else {
      await fs.mkdir(dest, { recursive: true });
      execSync(`cp -a "${src}/." "${dest}/"`, { stdio: "inherit" });
    }
  } else {
    await fs.copyFile(src, dest);
  }
}
