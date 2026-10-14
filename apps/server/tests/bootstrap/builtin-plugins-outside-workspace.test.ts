/**
 * A bundled plugin uses nothing an installed one cannot. Every bundled plugin
 * is copied, without its `node_modules`, to a directory outside the
 * workspace. Each copy must pass the installer's package check, and is then
 * discovered there as a community package and loaded the way an approved
 * installed package is: its entry runs and every handler and guard imports.
 * Bare imports of the plugin SDK and zod resolve to the host's copies;
 * anything else a plugin imports it must ship.
 *
 * Vitest resolves dynamic imports itself, where Node's module hooks do not
 * run, so the loading happens in a plain Node process with tsx, as the server
 * runs.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { validatePluginBundle } from "../../src/routes/api/install/plugin-bundle.js";
import type { ExtractedEntry } from "../../src/routes/api/install/shared.js";

const run = promisify(execFile);
const serverRoot = path.resolve(import.meta.dirname, "../..");
const pluginsRoot = path.resolve(serverRoot, "../../plugins");
const source = (file: string) =>
  JSON.stringify(pathToFileURL(path.join(serverRoot, file)).href);

/** The files of a plugin directory as the installer sees an unpacked ZIP. */
async function bundleEntries(root: string): Promise<ExtractedEntry[]> {
  const files = await fs.readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  return Promise.all(
    files
      .filter((file) => file.isFile())
      .map(async (file) => {
        const absolute = path.join(file.parentPath, file.name);
        return {
          relativePath: path.relative(root, absolute).split(path.sep).join("/"),
          content: await fs.readFile(absolute),
        };
      }),
  );
}

let temp: string | undefined;
afterAll(async () => {
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

const RUNNER = `
import path from "node:path";
import {
  createPluginRegistry,
  discoverPluginsMulti,
  loadPluginDefinition,
  loadPluginSummary,
  loadRuntime,
} from "@covel/plugin-loader";
import {
  createHookPipeline,
  createPluginRpcRegistry,
  PluginServiceRegistry,
  PluginExtensionHost,
} from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import { ToolRegistry } from "@covel/tools";
import { createBootstrapPluginEntries } from ${source("src/routes/api/bootstrap/plugin-entry.ts")};

const [builtinRoot, installedRoot] = process.argv.slice(2);
const discoveries = (await discoverPluginsMulti([builtinRoot, installedRoot]))
  .filter((discovery) => discovery.source === "community");
const registry = createPluginRegistry();
const manifestCache = new Map();
const failures = {};
const definitions = new Map();
for (const discovery of discoveries)
  definitions.set(discovery.id, await loadPluginDefinition(discovery));
// Contract schemas resolve across packages, as the server resolves them.
const contracts = Object.assign(
  {},
  ...[...definitions.values()].map(
    (definition) => definition.packageManifest?.contractSchemas ?? {},
  ),
);
for (const discovery of discoveries) {
  const definition = definitions.get(discovery.id);
  registry.register({
    id: discovery.id,
    source: discovery.source,
    rootPath: discovery.rootPath,
    summary: await loadPluginSummary(discovery, undefined, definition),
    packageManifest: definition.packageManifest,
    manifests: definition.manifests,
    loadedRuntimes: new Map(),
    status: "registered",
  });
  manifestCache.set(discovery.id, definition.manifests);
  for (const record of definition.manifests) {
    try {
      await loadRuntime(
        discovery,
        record.manifest.name,
        undefined,
        definition,
        contracts,
      );
    } catch (error) {
      failures[record.manifest.name] = String(error?.message ?? error);
    }
  }
}
const store = createMemoryStore();
const services = new PluginServiceRegistry({
  list: async () => discoveries.map((item) => item.id),
  ensure: async () => {},
});
const entries = await createBootstrapPluginEntries({
  discoveryMap: new Map(discoveries.map((item) => [item.id, item])),
  manifestCache,
  pluginRegistry: registry,
  store,
  tools: new ToolRegistry(),
  hookPipeline: createHookPipeline(),
  rpcRegistry: createPluginRpcRegistry(),
  services,
  extensions: new PluginExtensionHost(services),
  isCommunityServerCodeApproved: () => true,
  development: false,
});
for (const discovery of discoveries) {
  try {
    await entries.ensurePluginEntry(discovery.id, "session");
    const error = registry.get(discovery.id)?.error;
    if (error) failures[discovery.id] = String(error.message ?? error);
  } catch (error) {
    failures[discovery.id] = String(error?.message ?? error);
  }
}
await entries.close();
await store.close();
console.log(JSON.stringify({
  plugins: discoveries.map((item) => item.id).sort(),
  failures,
}));
`;

it("loads every bundled plugin from a directory outside the workspace", async () => {
  temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "covel-outside-workspace-")),
  );
  const installed = path.join(temp, "plugins");
  const builtin = path.join(temp, "empty");
  await fs.mkdir(builtin);
  const bundled = (await fs.readdir(pluginsRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith("_") &&
        !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .sort();
  for (const name of bundled)
    await fs.cp(path.join(pluginsRoot, name), path.join(installed, name), {
      recursive: true,
      filter: (file) =>
        !["node_modules", "tests"].includes(path.basename(file)),
    });
  const rejected: Record<string, string> = {};
  for (const name of bundled) {
    try {
      validatePluginBundle(
        await bundleEntries(path.join(installed, name)),
        new Set(),
      );
    } catch (error) {
      rejected[name] = error instanceof Error ? error.message : String(error);
    }
  }
  expect(rejected).toEqual({});
  const runner = path.join(serverRoot, `.outside-workspace-${process.pid}.mts`);
  await fs.writeFile(runner, RUNNER);
  try {
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", runner, builtin, installed],
      { cwd: serverRoot, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
    );
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      plugins: string[];
      failures: Record<string, string>;
    };
    expect(result.plugins).toEqual(bundled);
    expect(result.failures).toEqual({});
  } finally {
    await fs.rm(runner, { force: true });
  }
}, 180_000);
