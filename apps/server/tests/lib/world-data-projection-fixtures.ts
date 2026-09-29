import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePluginMd, type PluginRegistryEntry } from "@covel/plugin-loader";
import type { OrderedWorldDataSource } from "../../src/world-data/types.js";

export const NOW = "2026-01-01T00:00:00.000Z";
export const WORLD_IR_SCHEMA = "contract:world-ir@1";

export const VALID_WORLD_IR = {
  schemaVersion: 1,
  summary: "A compact test world.",
  entities: [
    {
      id: "harbor",
      type: "location",
      name: "Harbor",
      attributes: { safe: true, population: 12 },
    },
  ],
  relations: [],
  events: [],
  statements: [
    {
      id: "harbor-rule",
      type: "rule",
      content: "The harbor closes at dusk.",
      subjectIds: ["harbor"],
    },
  ],
} as const;

function jsonSchema(required: readonly string[]): string {
  return JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: true,
    required,
    properties: {
      id: { type: "string", minLength: 1 },
      kind: { type: "string", minLength: 1 },
    },
  });
}

export async function makeSource(
  value: unknown,
): Promise<OrderedWorldDataSource> {
  const root = await mkdtemp(path.join(tmpdir(), "covel-world-projection-"));
  await writeFile(path.join(root, "world-ir.json"), JSON.stringify(value));
  return {
    id: "world-ir",
    descriptor: {
      kind: "json",
      path: "world-ir.json",
      schema: WORLD_IR_SCHEMA,
      to: "world:metadata.ir",
      effects: ["projections"],
    },
    order: 0,
    origin: "world",
    overridden: false,
    pathOrigin: { descriptorRoot: root, origin: "world" },
    schemaOrigin: { descriptorRoot: root, origin: "world" },
    resolvedOrder: 0,
  };
}

export async function makePlugin(options: {
  readonly root: string;
  readonly id: string;
  readonly handlers: Readonly<Record<string, string>>;
  readonly projections: PluginRegistryEntry["worldProjections"];
  readonly namespaces: readonly string[];
  readonly schemaRequired?: readonly string[];
  readonly source?: PluginRegistryEntry["source"];
  readonly contract?: string;
}): Promise<PluginRegistryEntry> {
  const pluginRoot = path.join(options.root, options.id);
  await mkdir(path.join(pluginRoot, "handlers"), { recursive: true });
  await mkdir(path.join(pluginRoot, "schemas"), { recursive: true });
  for (const [name, source] of Object.entries(options.handlers)) {
    await writeFile(path.join(pluginRoot, "handlers", name), source);
  }
  for (const namespace of options.namespaces) {
    await writeFile(
      path.join(pluginRoot, "schemas", `${namespace}.schema.json`),
      jsonSchema(options.schemaRequired ?? ["id"]),
    );
  }
  return {
    id: options.id,
    packageManifest: makePackageManifest(
      options.id,
      options.namespaces,
      pluginRoot,
      options.contract,
    ),
    source: options.source ?? "builtin",
    rootPath: pluginRoot,
    summary: {
      id: options.id,
      name: options.id,
      description: "",
      pluginType: "plugin",
      runtimeCount: 0,
    },
    dataSchemas: Object.fromEntries(
      options.namespaces.map((namespace) => [
        namespace,
        {
          namespace,
          schemaVersion: 1,
          acceptsWorldData: true,
          schema: `./schemas/${namespace}.schema.json`,
        },
      ]),
    ),
    worldProjections: options.projections,
    loadedRuntimes: new Map(),
    status: "registered",
  };
}

export function registry(entries: readonly PluginRegistryEntry[]) {
  const byId = new Map(
    [worldIrEntry(), ...entries].map((entry) => [entry.id, entry]),
  );
  return { get: (pluginId: string) => byId.get(pluginId), getAll: () => byId };
}

function dataContractFor(pluginId: string, namespace: string): string {
  const names: Record<string, string> = {
    "character-blueprint/blueprints": "character.blueprints@1",
    "character-presence/assets": "character.portrait-assets@1",
    "character-presence/presence": "character.portraits@1",
    "living-world-rules/rules": "world.rules@1",
    "scene-stage/assets": "stage.scene-assets@1",
    "scene-stage/scenes": "stage.scenes@1",
    "inventory/items": "inventory.items@1",
    "affinity/affinity": "character.affinity@1",
    "core-quest/quests": "quests@1",
  };
  return names[`${pluginId}/${namespace}`] ?? `${pluginId}.${namespace}@1`;
}

export function makePackageManifest(
  id: string,
  namespaces: readonly string[],
  rootPath: string,
  contract?: string,
) {
  const contracts = Object.fromEntries(
    namespaces.map((namespace) => [
      contract ?? dataContractFor(id, namespace),
      { schema: `./schemas/${namespace}.schema.json` },
    ]),
  );
  return parsePluginMd(
    `---\n${JSON.stringify({ id, kind: "plugin", description: "Fixture", contracts, contributes: { data: Object.fromEntries(namespaces.map((namespace) => [namespace, { version: 1, schema: `./schemas/${namespace}.schema.json`, accepts: [contract ?? dataContractFor(id, namespace)] }])) } })}\n---`,
    path.join(rootPath, "PLUGIN.md"),
  );
}

export function worldIrEntry(): PluginRegistryEntry {
  const rootPath = path.resolve(
    import.meta.dirname,
    "../../../../plugins/world-ir",
  );
  return {
    id: "world-ir",
    source: "builtin",
    rootPath,
    summary: {
      id: "world-ir",
      name: "World IR",
      description: "",
      pluginType: "plugin",
      runtimeCount: 0,
    },
    packageManifest: parsePluginMd(
      `---\n${JSON.stringify({ id: "world-ir", kind: "plugin", description: "World IR schema", contracts: { "world-ir@1": { schema: "./schemas/world-ir.schema.json" } } })}\n---`,
      path.join(rootPath, "PLUGIN.md"),
    ),
    loadedRuntimes: new Map(),
    status: "registered",
  };
}
