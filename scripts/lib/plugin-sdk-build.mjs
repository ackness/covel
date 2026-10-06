// The plugin SDK is the one workspace package that is read from its build
// output; every other package exports its TypeScript source. `pnpm install`
// builds it, a `git pull` does not. A build older than its source fails at the
// first import of a name it does not have yet, and the server only logs that
// per plugin and goes on without those plugins.
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import crossSpawn from "cross-spawn";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_SDK = "@covel/plugin-handlers-utils";
const PLUGIN_SDK_DIR = join(REPO_ROOT, "packages/plugin-handlers-utils");
// The build writes every output each time, so the time of one output is the
// time of the build.
const ENTRY = join("dist", "index.js");
// Files outside `src/` that change what the build writes.
const BUILD_CONFIG = ["package.json", "tsconfig.json", "tsconfig.build.json"];

const modifiedAt = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * Why the build in `<dir>/dist` must be made again, or `undefined` when it is
 * current: it is missing, or an input was written after it.
 */
export function pluginSdkStaleReason(dir = PLUGIN_SDK_DIR, now = Date.now()) {
  const built = modifiedAt(join(dir, ENTRY));
  if (built === undefined) return `${ENTRY} is missing`;

  const src = join(dir, "src");
  const inputs = [
    ...readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name)),
    ...BUILD_CONFIG.map((name) => join(dir, name)),
  ];
  for (const input of inputs) {
    const time = modifiedAt(input);
    // A time in the future says nothing about the build. Counted as newer, it
    // would start a build at every start of the process.
    if (time !== undefined && time > built && time <= now)
      return `${relative(dir, input)} is newer than the build`;
  }
  return undefined;
}

// The package's own build script, so this stays right when that script changes.
const buildPluginSdk = () => {
  crossSpawn.sync("pnpm", ["--filter", PLUGIN_SDK, "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
};

/**
 * Build the plugin SDK when its build is not current. Returns whether it
 * built. Throws when the build wrote nothing: a process that goes on would
 * read the old build.
 *
 * The build is judged by what it wrote, not by its exit code. The compiler
 * writes its output for a type error too and reports the error; the rest of
 * the workspace runs from source with no type check, so a type error in the
 * SDK does not stop a dev process either.
 */
export function ensurePluginSdkBuild({
  dir = PLUGIN_SDK_DIR,
  build = buildPluginSdk,
  log = console.log,
} = {}) {
  const reason = pluginSdkStaleReason(dir);
  if (!reason) return false;
  log(`[plugin-sdk] ${reason}; building ${PLUGIN_SDK}`);
  const before = modifiedAt(join(dir, ENTRY));
  build();
  if (modifiedAt(join(dir, ENTRY)) === before)
    throw new Error(
      `[plugin-sdk] The build of ${PLUGIN_SDK} wrote no output, so the process did not start. Correct the errors above, or run: pnpm --filter ${PLUGIN_SDK} build`,
    );
  return true;
}
