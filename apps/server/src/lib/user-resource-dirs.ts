import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readRuntimeEnv } from "@covel/shared";

/** Installation and discovery must agree even before the directories exist. */
export function resolveUserResourceDirs(env = readRuntimeEnv()) {
  const home = env.covelHome ?? join(homedir(), ".covel");
  return {
    worlds: resolve(env.userWorldsDir ?? join(home, "worlds")),
    plugins: resolve(env.userPluginsDir ?? join(home, "plugins")),
  };
}
