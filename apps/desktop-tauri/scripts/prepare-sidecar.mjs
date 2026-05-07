/**
 * Prepare everything the Tauri sidecar launcher expects:
 *
 *   1. apps/desktop/staging/server/ must exist and be smoke-tested
 *      (we reuse @covel/desktop's build so we don't duplicate staging logic).
 *   2. web-dist must sit next to staging/server so the server can
 *      SERVE_STATIC it.
 *   3. src-tauri/binaries/node (or node.exe) must be the official Node
 *      runtime for the target platform. We download from nodejs.org on
 *      demand and cache under src-tauri/binaries/.cache/.
 *
 * Invocation:
 *   node scripts/prepare-sidecar.mjs                      # host platform
 *   node scripts/prepare-sidecar.mjs --target aarch64-apple-darwin
 */
import { execSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopTauriRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopTauriRoot, "../..");
const srcTauri = path.join(desktopTauriRoot, "src-tauri");
const binariesDir = path.join(srcTauri, "binaries");
const cacheDir = path.join(binariesDir, ".cache");
const npmCacheDir = path.join(cacheDir, "npm");
const stagingServer = path.join(repoRoot, "apps/desktop/staging/server");
const stagingWebDist = path.join(repoRoot, "apps/desktop/staging/web-dist");
const resourcesDir = path.join(srcTauri, "resources");
const resourcesServer = path.join(resourcesDir, "server");
const resourcesWebDist = path.join(resourcesDir, "web-dist");

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let targetTriple = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target" && args[i + 1]) {
    targetTriple = args[++i];
  }
}

const NODE_VERSION = "22.14.0"; // LTS; align with engines.node >=20.19.0

const target = targetTriple ?? detectHostTriple();
const nodeRelease = resolveNodeRelease(target);

console.log(`[prepare-sidecar] target: ${target}`);
console.log(`[prepare-sidecar] node release: ${nodeRelease.assetName}`);

// ── Step 1: ensure desktop staging ───────────────────────────────────

if (
  !(await exists(path.join(stagingServer, "src/index.ts"))) ||
  !(await exists(path.join(stagingServer, "node_modules/tsx/dist/cli.mjs")))
) {
  console.log(
    "[prepare-sidecar] apps/desktop/staging missing — running `pnpm --filter @covel/desktop build`…",
  );
  execSync("pnpm --filter @covel/desktop build", {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

if (!(await exists(stagingWebDist))) {
  console.warn(
    `[prepare-sidecar] ⚠ web-dist missing at ${stagingWebDist}. Server will 404 on HTML routes.`,
  );
}
console.log("[prepare-sidecar] ✓ staging server ready");

// ── Step 2: download node binary ────────────────────────────────────

await fs.mkdir(cacheDir, { recursive: true });
const archivePath = path.join(cacheDir, nodeRelease.assetName);
if (!(await exists(archivePath))) {
  console.log(`[prepare-sidecar] downloading ${nodeRelease.url}…`);
  await downloadFile(nodeRelease.url, archivePath);
} else {
  console.log(`[prepare-sidecar] ✓ cached ${nodeRelease.assetName}`);
}

const extractRoot = path.join(cacheDir, `extracted-${nodeRelease.dirname}`);
if (!(await exists(path.join(extractRoot, nodeRelease.innerNodePath)))) {
  console.log("[prepare-sidecar] extracting node binary…");
  await fs.mkdir(extractRoot, { recursive: true });
  await extractArchive(archivePath, extractRoot, nodeRelease);
}

// ── Step 3: stage binaries/node ────────────────────────────────────

const destName = target.includes("windows") ? "node.exe" : "node";
const destPath = path.join(binariesDir, destName);
const srcNode = path.join(extractRoot, nodeRelease.innerNodePath);

await fs.copyFile(srcNode, destPath);
if (!target.includes("windows")) {
  await fs.chmod(destPath, 0o755);
}
// Ad-hoc re-sign on macOS. The Node tarball's bundled signature is
// issued to `Node.js Foundation`, and a file extracted from a downloaded
// archive carries `com.apple.provenance` — a SIP-protected xattr that
// `xattr -c` can't remove. On macOS 15+ Gatekeeper kills the child with
// SIGKILL the moment tauri's Command tries to exec it, and there's no
// stdout/stderr to diagnose the failure (Tauri just sees a 30s
// /api/health timeout). `codesign --sign -` replaces the vendor
// signature with an ad-hoc one, which the OS trusts for local use.
if (target.includes("darwin")) {
  try {
    execSync(`codesign --force --sign - "${destPath}"`, { stdio: "ignore" });
  } catch (err) {
    console.warn(
      `[prepare-sidecar] codesign re-sign failed — sidecar may be blocked by Gatekeeper: ${err.message}`,
    );
  }
}
console.log(`[prepare-sidecar] ✓ node binary at ${destPath}`);

// ── Step 4: mirror staging → src-tauri/resources + rebuild native deps ──
//
// We do NOT mutate apps/desktop/staging, because Electron and our bundled
// Node have different ABIs (Electron 40 uses NODE_MODULE_VERSION 141,
// plain Node 22 is 127). Rebuilding better-sqlite3 for one breaks the
// other. So we take a copy and rebuild here.

console.log("[prepare-sidecar] mirroring staging → src-tauri/resources/…");
await fs.rm(resourcesServer, { recursive: true, force: true });
await fs.rm(resourcesWebDist, { recursive: true, force: true });
await fs.mkdir(resourcesDir, { recursive: true });
await copyDir(stagingServer, resourcesServer);
if (await exists(stagingWebDist)) {
  await copyDir(stagingWebDist, resourcesWebDist);
}
console.log("[prepare-sidecar] ✓ resources mirrored");

console.log(
  "[prepare-sidecar] rebuilding better-sqlite3 against bundled Node…",
);
const nodeDir =
  nodeRelease.format === "zip"
    ? path.join(extractRoot, nodeRelease.dirname) // Windows: node.exe + npm.cmd at root
    : path.join(extractRoot, nodeRelease.dirname, "bin"); // POSIX: bin/node + bin/npm

rebuildBetterSqlite3(resourcesServer, nodeDir);
console.log("[prepare-sidecar] ✓ better-sqlite3 rebuilt");

// ── Helpers ─────────────────────────────────────────────────────────

function detectHostTriple() {
  const { platform, arch } = process;
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "win32") {
    return arch === "arm64"
      ? "aarch64-pc-windows-msvc"
      : "x86_64-pc-windows-msvc";
  }
  if (platform === "linux") {
    return arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  }
  throw new Error(`unsupported host platform: ${platform}-${arch}`);
}

function resolveNodeRelease(triple) {
  // Map Rust target triples to Node.js release asset names.
  // Format: https://nodejs.org/dist/vX.Y.Z/node-vX.Y.Z-<platform>-<arch>.tar.gz
  const map = {
    "aarch64-apple-darwin": {
      platform: "darwin",
      arch: "arm64",
      format: "tar.gz",
    },
    "x86_64-apple-darwin": {
      platform: "darwin",
      arch: "x64",
      format: "tar.gz",
    },
    "aarch64-unknown-linux-gnu": {
      platform: "linux",
      arch: "arm64",
      format: "tar.gz",
    },
    "x86_64-unknown-linux-gnu": {
      platform: "linux",
      arch: "x64",
      format: "tar.gz",
    },
    "x86_64-pc-windows-msvc": {
      platform: "win",
      arch: "x64",
      format: "zip",
    },
    "aarch64-pc-windows-msvc": {
      platform: "win",
      arch: "arm64",
      format: "zip",
    },
  };
  const entry = map[triple];
  if (!entry) throw new Error(`unsupported target triple: ${triple}`);
  const version = `v${NODE_VERSION}`;
  const dirname = `node-${version}-${entry.platform}-${entry.arch}`;
  const assetName = `${dirname}.${entry.format}`;
  const url = `https://nodejs.org/dist/${version}/${assetName}`;
  const innerNodePath =
    entry.platform === "win" ? `${dirname}/node.exe` : `${dirname}/bin/node`;
  return { url, assetName, dirname, innerNodePath, format: entry.format };
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download ${url}: HTTP ${res.status}`);
  }
  if (!res.body) throw new Error(`download ${url}: empty body`);
  const out = createWriteStream(destPath);
  await pipeline(res.body, out);
}

async function extractArchive(archivePath, destDir, release) {
  // Use system tools. macOS/Linux and Windows 10+ all ship `tar`.
  if (release.format === "tar.gz") {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: "inherit" });
  } else if (release.format === "zip") {
    // Prefer system unzip; fall back to bsdtar (available on Windows 10+ and
    // macOS) since `tar` can also read zip via libarchive.
    try {
      execSync(`unzip -q -o "${archivePath}" -d "${destDir}"`, {
        stdio: "inherit",
      });
    } catch {
      execSync(`tar -xf "${archivePath}" -C "${destDir}"`, {
        stdio: "inherit",
      });
    }
  } else {
    throw new Error(`unknown format: ${release.format}`);
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  // Prefer system cp -a for speed and to preserve symlinks/permissions.
  // fs.cp is also available but 2-3x slower for many small files.
  const { platform } = process;
  if (platform === "win32") {
    execSync(`xcopy "${src}" "${dest}" /E /I /Y /Q`, { stdio: "inherit" });
  } else {
    await fs.mkdir(dest, { recursive: true });
    execSync(`cp -a "${src}/." "${dest}/"`, { stdio: "inherit" });
  }
}

function rebuildBetterSqlite3(serverDir, nodeBinDir) {
  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const nodeGypCmd = resolveNodeGypCommand(serverDir, isWin);
  const nodeRootDir =
    path.basename(nodeBinDir) === "bin" ? path.dirname(nodeBinDir) : nodeBinDir;
  const pathParts = [
    nodeBinDir,
    path.join(serverDir, "node_modules/.bin"),
    path.dirname(nodeGypCmd),
    process.env.PATH ?? "",
  ].filter(Boolean);
  const env = {
    ...process.env,
    PATH: pathParts.join(sep),
    npm_config_cache: npmCacheDir,
    npm_config_devdir: path.join(npmCacheDir, "node-gyp"),
    npm_config_nodedir: nodeRootDir,
    npm_config_node_gyp: nodeGypCmd,
    npm_config_update_notifier: "false",
    // Force npm to use the bundled node.
    npm_config_node_version: NODE_VERSION,
  };

  // Prefer npm (ships with Node tarball) over pnpm to avoid workspace
  // resolution. `npm rebuild` runs the `install` script in-place.
  const npmCmd = isWin ? "npm.cmd" : "npm";
  try {
    execSync(`"${path.join(nodeBinDir, npmCmd)}" rebuild better-sqlite3`, {
      cwd: serverDir,
      env,
      stdio: "inherit",
    });
  } catch (err) {
    // Fallback: invoke node-gyp directly if npm rebuild is unavailable
    // (some stripped tarballs). Try `node-gyp rebuild` in the module's dir.
    const bsqlDir = path.join(serverDir, "node_modules/better-sqlite3");
    console.warn(
      "[prepare-sidecar] npm rebuild failed, trying node-gyp directly",
    );
    execSync(`"${nodeGypCmd}" rebuild --release`, {
      cwd: bsqlDir,
      env,
      stdio: "inherit",
    });
  }
}

function resolveNodeGypCommand(serverDir, isWin) {
  const binName = isWin ? "node-gyp.cmd" : "node-gyp";
  const candidates = [
    path.join(serverDir, "node_modules/.bin", binName),
    path.join(repoRoot, "node_modules/.pnpm/node_modules/.bin", binName),
    path.join(repoRoot, "node_modules/.bin", binName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `node-gyp command not found; checked: ${candidates.join(", ")}`,
  );
}
