// Makes the build of the plugin SDK current before a process reads it.
//
// The server's `dev` scripts preload this file (`--import`), so it runs at
// every start of the server process: when the dev command starts, and each
// time the watcher restarts the server after a file changed. It also runs as a
// command: node scripts/ensure-plugin-sdk.mjs
import process from "node:process";

import { ensurePluginSdkBuild } from "./lib/plugin-sdk-build.mjs";

try {
  ensurePluginSdkBuild();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
