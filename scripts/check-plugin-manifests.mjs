import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

export function checkPluginManifests(repoRoot = defaultRoot) {
  const pluginDir = path.join(repoRoot, "plugins");
  const plugins = readdirSync(pluginDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => path.join(pluginDir, entry.name))
    .sort();
  if (plugins.length === 0)
    throw new Error("No active plugin directories found.");

  const validator = path.join(
    repoRoot,
    "packages",
    "plugin-loader",
    "scripts",
    "validate-manifest.ts",
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", validator, ...plugins],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Plugin manifest validation failed (${result.status}):\n${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    checkPluginManifests();
    console.log("Active plugin manifests passed strict validation.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
