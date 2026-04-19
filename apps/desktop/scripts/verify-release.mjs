import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "../..");
const releaseRoot = path.join(projectRoot, "release");
const platform = process.argv[2];

if (!platform || !["mac", "win"].includes(platform)) {
  console.error("Usage: node apps/desktop/scripts/verify-release.mjs <mac|win>");
  process.exit(1);
}

function mustExist(baseDir, relativePath) {
  const target = path.join(baseDir, relativePath);
  if (!fs.existsSync(target)) {
    throw new Error(`Missing required packaged file: ${target}`);
  }
}

function collectResourceDirs() {
  if (!fs.existsSync(releaseRoot)) {
    return [];
  }

  if (platform === "mac") {
    return fs
      .readdirSync(releaseRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
      .map((entry) =>
        path.join(releaseRoot, entry.name, "Covel.app", "Contents", "Resources"),
      )
      .filter((dir) => fs.existsSync(dir));
  }

  return fs
    .readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("unpacked"))
    .map((entry) => path.join(releaseRoot, entry.name, "resources"))
    .filter((dir) => fs.existsSync(dir));
}

const resourceDirs = collectResourceDirs();
if (resourceDirs.length === 0) {
  console.error(`No unpacked ${platform} release directories found under ${releaseRoot}`);
  process.exit(1);
}

for (const resourcesDir of resourceDirs) {
  mustExist(resourcesDir, "server/src/index.ts");
  mustExist(resourcesDir, "server/node_modules/tsx/dist/cli.mjs");
  mustExist(resourcesDir, "server/node_modules/esbuild/package.json");
  mustExist(resourcesDir, "web-dist/index.html");
}

console.log(`Verified ${platform} desktop release resources:`);
for (const resourcesDir of resourceDirs) {
  console.log(`  ✓ ${resourcesDir}`);
}
