import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "../..");
// electron-builder writes to release/electron/ (see electron-builder.yml).
// The repo-level release/ groups outputs from multiple shells.
const releaseRoot = path.join(projectRoot, "release", "electron");
const platform = process.argv[2];

if (!platform || !["mac", "win"].includes(platform)) {
  console.error(
    "Usage: node apps/desktop/scripts/verify-release.mjs <mac|win>",
  );
  process.exit(1);
}

function mustExist(baseDir, relativePath) {
  const target = path.join(baseDir, relativePath);
  if (!fs.existsSync(target)) {
    throw new Error(`Missing required packaged file: ${target}`);
  }
}

function directoryHasFile(dir, predicate) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(predicate);
}

// Guard against regressions where overly broad electron-builder filters
// (e.g. "!**/*.md") silently strip runtime-critical content: world lore,
// plugin manifests, and server prompts.
function mustHaveBundledWorlds(resourcesDir) {
  const worldsDir = path.join(resourcesDir, "server/worlds");
  if (!fs.existsSync(worldsDir)) {
    throw new Error(`Bundled worlds dir missing: ${worldsDir} `);
  }
  const worldDirs = fs
    .readdirSync(worldsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  if (worldDirs.length === 0) {
    throw new Error(`No bundled worlds present under ${worldsDir} `);
  }
  for (const entry of worldDirs) {
    const dir = path.join(worldsDir, entry.name);
    if (!fs.existsSync(path.join(dir, "world.yaml"))) {
      throw new Error(`Bundled world ${entry.name} is missing world.yaml`);
    }
    const hasLore = directoryHasFile(dir, (f) =>
      /^WORLD(\.[a-z-]+)?\.md$/i.test(f),
    );
    if (!hasLore) {
      throw new Error(
        `Bundled world ${entry.name} is missing WORLD *.md(likely stripped by a too - broad electron - builder filter such as "!**/*.md")`,
      );
    }
  }
}

function mustHaveBundledPlugins(resourcesDir) {
  const pluginsDir = path.join(resourcesDir, "server/plugins");
  if (!fs.existsSync(pluginsDir)) {
    throw new Error(`Bundled plugins dir missing: ${pluginsDir} `);
  }
  const pluginDirs = fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  if (pluginDirs.length === 0) {
    throw new Error(`No bundled plugins present under ${pluginsDir} `);
  }
  const isPluginManifest = (f) => /^PLUGIN(\.[a-z-]+)?\.md$/i.test(f);
  for (const entry of pluginDirs) {
    const dir = path.join(pluginsDir, entry.name);
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      throw new Error(`Bundled plugin ${entry.name} is missing package.json`);
    }
    // Single-runtime layout: PLUGIN.md at the root.
    // Multi-runtime layout: PLUGIN.md under runtimes/<sub>/ instead.
    const hasRootManifest = directoryHasFile(dir, isPluginManifest);
    let hasNestedManifest = false;
    const runtimesDir = path.join(dir, "runtimes");
    if (fs.existsSync(runtimesDir)) {
      const subs = fs
        .readdirSync(runtimesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      hasNestedManifest = subs.some((sub) =>
        directoryHasFile(path.join(runtimesDir, sub.name), isPluginManifest),
      );
    }
    if (!hasRootManifest && !hasNestedManifest) {
      throw new Error(
        `Bundled plugin ${entry.name} is missing PLUGIN.md (looked at ${dir}/PLUGIN.md and ${dir}/runtimes/<sub>/PLUGIN.md — likely stripped by a too-broad electron-builder filter)`,
      );
    }
  }
}

function mustHaveBundledPrompts(resourcesDir) {
  const promptsDir = path.join(resourcesDir, "server/prompts/server");
  if (!fs.existsSync(promptsDir)) {
    throw new Error(`Bundled prompts dir missing: ${promptsDir} `);
  }
  const hasAnyPrompt = directoryHasFile(promptsDir, (f) => f.endsWith(".md"));
  if (!hasAnyPrompt) {
    throw new Error(
      `No prompt files under ${promptsDir} (likely stripped by a too - broad electron - builder filter)`,
    );
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
        path.join(
          releaseRoot,
          entry.name,
          "Covel.app",
          "Contents",
          "Resources",
        ),
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
  console.error(
    `No unpacked ${platform} release directories found under ${releaseRoot} `,
  );
  process.exit(1);
}

for (const resourcesDir of resourceDirs) {
  mustExist(resourcesDir, "server/src/index.ts");
  mustExist(resourcesDir, "server/node_modules/tsx/dist/cli.mjs");
  mustExist(resourcesDir, "server/node_modules/esbuild/package.json");
  mustExist(resourcesDir, "web-dist/index.html");
  mustHaveBundledWorlds(resourcesDir);
  mustHaveBundledPlugins(resourcesDir);
  mustHaveBundledPrompts(resourcesDir);
}

console.log(`Verified ${platform} desktop release resources: `);
for (const resourcesDir of resourceDirs) {
  console.log(`  ✓ ${resourcesDir} `);
}
