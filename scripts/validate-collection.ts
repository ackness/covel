#!/usr/bin/env tsx
import { inventoryWorldData } from "../apps/server/src/world-data/requirements.js";
import { loadPluginCatalogue } from "../apps/server/src/world-data/validate-world-package.js";
import { BUILTIN_PLUGIN_PACKS } from "../apps/server/src/config/plugin-packs.js";

/**
 * Static check of a collection directory: `pnpm validate:collection <dir>`.
 *
 * It runs the same completeness check the installer runs for a preview, against
 * the plugins bundled in this repository, so an author sees in CI what a
 * player would see before installing. Members pinned in other repositories are
 * not downloaded; they are listed so the author knows the result is partial.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { discoverPluginAt } from "../packages/plugin-loader/src/discover.js";
import { loadPluginDefinition } from "../packages/plugin-loader/src/load.js";
import {
  COLLECTION_MANIFEST_FILE,
  checkCollection,
  getRuntimeSpec,
  collectionManifestSchema,
  collectionPluginFacts,
  collectionWorldFacts,
  validateWorldManifest,
  formatValidationErrors,
  type CollectionPluginFacts,
  type CollectionProblem,
  type CollectionWorldFacts,
} from "@covel/shared";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const [directory] = process.argv.slice(2);
if (!directory) {
  console.error("Usage: validate-collection.ts <collection-dir>");
  process.exit(2);
}

/**
 * The loaded root manifest: its ID comes from the directory when it writes
 * none, and it provides the contracts its runtimes output.
 */
async function readPluginFacts(pluginDir: string) {
  const discovery = await discoverPluginAt(pluginDir);
  if (!discovery) throw new Error(`no PLUGIN.md in ${pluginDir}`);
  const definition = await loadPluginDefinition(discovery);
  return collectionPluginFacts(
    definition.packageManifest.plugin,
    definition.manifests.map(({ manifest }) => ({
      presentation: getRuntimeSpec(manifest).presentation,
    })),
  );
}

async function bundledPlugins(): Promise<CollectionPluginFacts[]> {
  const root = path.join(REPO_ROOT, "plugins");
  const facts: CollectionPluginFacts[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    try {
      facts.push(await readPluginFacts(path.join(root, entry.name)));
    } catch {
      // A directory without a readable manifest is not a bundled plugin.
    }
  }
  return facts;
}

const problems: CollectionProblem[] = [];
const notes: string[] = [];
const fail = (message: string, packageId?: string) =>
  problems.push({
    level: "error",
    message,
    ...(packageId ? { packageId } : {}),
  });

let raw: unknown;
try {
  raw = YAML.parse(
    await readFile(path.join(directory, COLLECTION_MANIFEST_FILE), "utf-8"),
  );
} catch (error) {
  console.error(
    `✗ ${path.join(directory, COLLECTION_MANIFEST_FILE)}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
const parsed = collectionManifestSchema.safeParse(raw);
if (!parsed.success) {
  for (const issue of parsed.error.issues)
    console.error(`✗ ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  process.exit(1);
}
const manifest = parsed.data;

const plugins: CollectionPluginFacts[] = [];
const includedPluginDirs: string[] = [];
for (const member of manifest.plugins) {
  if ("repository" in member) {
    notes.push(
      `plugin ${member.repository}@${member.commit.slice(0, 7)}${member.path ? `:${member.path}` : ""} is pinned elsewhere and was not read`,
    );
    continue;
  }
  const pluginDir = path.join(directory, member.path);
  try {
    plugins.push(await readPluginFacts(pluginDir));
    includedPluginDirs.push(pluginDir);
  } catch (error) {
    fail(
      `${member.path}: not an installable plugin (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

const worlds: CollectionWorldFacts[] = [];
const sourceEntries = new Map(
  (await loadPluginCatalogue([path.join(REPO_ROOT, "plugins")])).getAll(),
);
for (const pluginDir of includedPluginDirs) {
  const discovery = await discoverPluginAt(pluginDir);
  if (!discovery) continue;
  const definition = await loadPluginDefinition(discovery);
  sourceEntries.set(discovery.id, {
    id: discovery.id,
    ...definition,
    source: "community",
    status: "discovered",
    loadedRuntimes: new Map(),
    summary: {
      id: discovery.id,
      name: discovery.id,
      description: definition.packageManifest.plugin.description,
      kind: definition.packageManifest.plugin.kind ?? "plugin",
      runtimeCount: definition.manifests.length,
    },
  });
}
const sourceCatalogue = {
  get: (id: string) => sourceEntries.get(id),
  getAll: () => sourceEntries,
};
for (const member of manifest.worlds) {
  if ("repository" in member) {
    notes.push(
      `world ${member.repository}@${member.commit.slice(0, 7)}${member.path ? `:${member.path}` : ""} is pinned elsewhere and was not read`,
    );
    continue;
  }
  try {
    const world = YAML.parse(
      await readFile(path.join(directory, member.path, "world.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    const validation = validateWorldManifest(world);
    if (!validation.valid) {
      fail(
        `${member.path}/world.yaml does not match the world schema:\n${formatValidationErrors(validation.errors ?? [])}`,
      );
      continue;
    }
    const facts = collectionWorldFacts(
      world,
      BUILTIN_PLUGIN_PACKS,
      path.basename(path.resolve(directory, member.path)),
    );
    const inventory = await inventoryWorldData({
      worldRoot: path.join(directory, member.path),
      worldId: facts.id,
      registry: sourceCatalogue,
    });
    worlds.push({
      ...facts,
      requires: [
        ...new Set([...facts.requires, ...inventory.requiredContracts]),
      ],
      requiredDataContracts: inventory.requiredDataContracts,
    });
  } catch (error) {
    fail(
      `${member.path}: not a world package (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

const hostVersion = (
  JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
    version: string;
  }
).version;
problems.push(
  ...checkCollection({
    worlds,
    plugins,
    available: await bundledPlugins(),
    hostVersion,
    collectionRange: manifest.covel,
  }),
);

for (const note of notes) console.log(`• ${note}`);
for (const problem of problems)
  console[problem.level === "error" ? "error" : "warn"](
    `${problem.level === "error" ? "✗" : "!"} ${problem.message}`,
  );
const errors = problems.filter((problem) => problem.level === "error").length;
if (errors > 0) {
  console.error(`✗ ${manifest.id}: ${errors} error(s)`);
  process.exit(1);
}
console.log(
  `✓ ${manifest.id}: ${plugins.length} plugin(s), ${worlds.length} world(s) checked against Covel ${hostVersion}`,
);
