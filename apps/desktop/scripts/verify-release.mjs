import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoPrivateConfig } from "./private-config.mjs";
import { verifyTargetNativePackages } from "./before-pack.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "../..");
// electron-builder writes to release/electron/ (see electron-builder.yml).
// The repo-level release/ groups outputs from multiple shells.
const releaseRoot = path.join(projectRoot, "release", "electron");
const platform = process.argv[2];

if (!platform || !["mac", "win", "linux"].includes(platform)) {
  console.error(
    "Usage: node apps/desktop/scripts/verify-release.mjs <mac|win|linux>",
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
    // `_`-prefixed dirs are not packages; the world-seed loader also skips
    // any dir without a valid world.yaml.
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"));
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
    // `_`-prefixed dirs are excluded from staging; tolerate one slipping
    // through an older build rather than failing the release.
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"));
  if (pluginDirs.length === 0) {
    throw new Error(`No bundled plugins present under ${pluginsDir} `);
  }
  for (const entry of pluginDirs) {
    const dir = path.join(pluginsDir, entry.name);
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      throw new Error(`Bundled plugin ${entry.name} is missing package.json`);
    }
    if (!fs.existsSync(path.join(dir, "PLUGIN.md"))) {
      throw new Error(
        `Bundled plugin ${entry.name} is missing root PLUGIN.md: ${dir}`,
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

  const directoryPattern =
    platform === "mac"
      ? /^mac(?:-(x64|arm64))?$/
      : platform === "win"
        ? /^win(?:-(x64|arm64))?-unpacked$/
        : /^linux(?:-(x64|arm64))?-unpacked$/;
  return fs
    .readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(platform))
    .map((entry) => {
      const match = directoryPattern.exec(entry.name);
      if (!match) {
        throw new Error(
          `Unrecognized unpacked ${platform} target directory: ${entry.name}`,
        );
      }
      const resourcesDir =
        platform === "mac"
          ? path.join(
              releaseRoot,
              entry.name,
              "Covel.app",
              "Contents",
              "Resources",
            )
          : path.join(releaseRoot, entry.name, "resources");
      return { resourcesDir, arch: match[1] ?? "x64" };
    });
}

const resourceDirs = collectResourceDirs();
if (resourceDirs.length === 0) {
  console.error(
    `No unpacked ${platform} release directories found under ${releaseRoot} `,
  );
  process.exit(1);
}

for (const { resourcesDir, arch } of resourceDirs) {
  const runtimeTarget = {
    platform: { mac: "darwin", win: "win32", linux: "linux" }[platform],
    arch,
  };
  // verify-staging checks the selected resource set and actual runtime, not
  // the build host's Node or the version claimed by the Electron npm package.
  verifyTargetNativePackages(path.join(resourcesDir, "server"), runtimeTarget);
  assertNoPrivateConfig(path.join(resourcesDir, "server"));
  mustExist(resourcesDir, "server/src/index.js");
  mustExist(resourcesDir, "server/node_modules/tsx/dist/loader.mjs");
  mustExist(resourcesDir, "server/node_modules/esbuild/package.json");
  mustExist(
    resourcesDir,
    "server/node_modules/@covel/ai-provider/data/model-db.json",
  );
  mustExist(resourcesDir, "web-dist/index.html");
  mustHaveBundledWorlds(resourcesDir);
  mustHaveBundledPlugins(resourcesDir);
  mustHaveBundledPrompts(resourcesDir);
  // Check the copied resources, not the staging tree. Both config paths must
  // boot under the actual pinned target binary, with no host runtime fallback.
  for (const flags of [[], ["--no-llm-toml"]]) {
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, "verify-staging.mjs"),
        "--resources",
        resourcesDir,
        "--platform",
        runtimeTarget.platform,
        "--arch",
        arch,
        ...flags,
      ],
      { cwd: desktopRoot, stdio: "inherit", timeout: 90_000 },
    );
  }
}

console.log(`Verified ${platform} desktop release resources: `);
for (const { resourcesDir } of resourceDirs) {
  console.log(`  ✓ ${resourcesDir} `);
}
