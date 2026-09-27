#!/usr/bin/env tsx
/** Validate one current-format plugin package, including all runtime files. */
import fs from "node:fs/promises";
import path from "node:path";
import { loadPluginDefinition } from "../src/load.js";
const args = process.argv.slice(2);
if (!args.length || args.some((arg) => arg.startsWith("--"))) {
  console.error(
    "Usage: pnpm validate:plugin <PLUGIN.md | RUNTIME.md | plugin-dir>...",
  );
  process.exit(2);
}
const visited = new Set<string>();
for (const arg of args) {
  try {
    let rootPath = path.resolve(arg);
    if ((await fs.stat(rootPath)).isFile()) rootPath = path.dirname(rootPath);
    if (path.basename(path.dirname(rootPath)) === "runtimes")
      rootPath = path.dirname(path.dirname(rootPath));
    rootPath = await fs.realpath(rootPath);
    if (visited.has(rootPath)) continue;
    visited.add(rootPath);
    const runtimeDir = path.join(rootPath, "runtimes");
    const entries = await fs
      .readdir(runtimeDir, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    const pluginMdPaths: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(runtimeDir, entry.name);
      if (
        await fs.stat(path.join(dir, "PLUGIN.md")).then(
          () => true,
          () => false,
        )
      )
        throw new Error(`${dir}: rename child PLUGIN.md to RUNTIME.md`);
      pluginMdPaths.push(path.join(dir, "RUNTIME.md"));
    }
    await loadPluginDefinition({
      id: path.basename(rootPath),
      rootPath,
      isMultiRuntime: await fs.stat(runtimeDir).then(
        () => true,
        () => false,
      ),
      pluginMdPaths,
    });
    console.log(`✓ ${rootPath}`);
  } catch (error) {
    console.error(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
