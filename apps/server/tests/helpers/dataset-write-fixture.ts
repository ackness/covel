import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPluginRegistry,
  discoverPluginAt,
  loadPluginDefinition,
} from "@covel/plugin-loader";
import type { DataOpKind } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  prepareWorldDataImportForSession,
  applyPreparedWorldDataImportForSession,
  syncWorldDataForSession,
} from "../../src/world-data/session-import.js";

export const DATASET_NOW = "2026-10-31T00:00:00.000Z";
export const RECORD_SCHEMA = {
  type: "object",
  required: ["id", "text"],
  properties: { id: { type: "string" }, text: { type: "string" } },
};

/** A discovered runtime-less package, and a world using its source convention. */
export async function datasetWriteFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dataset-write-"));
  const pluginRoot = path.join(root, "probe");
  const worldRoot = path.join(root, "worlds", "dataset-world");
  await mkdir(path.join(pluginRoot, "schemas"), { recursive: true });
  await mkdir(path.join(worldRoot, "data"), { recursive: true });
  await mkdir(path.join(worldRoot, "characters"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, "schemas/notes.json"),
    JSON.stringify(RECORD_SCHEMA),
  );
  await writeFile(
    path.join(pluginRoot, "PLUGIN.md"),
    `---\n${JSON.stringify({ id: "probe", kind: "plugin", version: "0.1.0", description: "Dataset writer", contracts: { "probe.notes@1": { schema: "./schemas/notes.json" } }, contributes: { data: { notes: { accepts: ["probe.notes@1"], schema: "./schemas/notes.json", authoring: { title: "Notes", source: { path: "data/notes.json", key: "id" } } } }, datasets: { notes: { schema: "./schemas/notes.json", key: "id", ops: ["set", "delete"] } } } })}\n---\n`,
  );
  const discovery = await discoverPluginAt(pluginRoot);
  if (!discovery) throw new Error("Fixture discovery failed");
  const definition = await loadPluginDefinition(discovery);
  const registry = createPluginRegistry();
  const entry = {
    id: "probe",
    source: "builtin" as const,
    rootPath: pluginRoot,
    packageManifest: definition.packageManifest,
    manifests: definition.manifests,
    summary: {
      id: "probe",
      name: "Probe",
      description: "Fixture",
      kind: "plugin" as const,
      runtimeCount: 0,
    },
    loadedRuntimes: new Map(),
    status: "registered" as const,
  };
  registry.register(entry);
  const policy = (
    ops: readonly DataOpKind[],
    schema: Readonly<Record<string, unknown>> | null = RECORD_SCHEMA,
  ) => {
    registry.register({
      ...registry.get("probe")!,
      datasets: { notes: { ...registry.get("probe")!.datasets!.notes!, ops } },
      packageManifest: {
        ...registry.get("probe")!.packageManifest!,
        datasetSchemas: schema === null ? {} : { notes: schema },
      },
    });
  };
  await writeFile(
    path.join(worldRoot, "world.yaml"),
    "id: dataset-world\nname: Dataset World\nsummary: Dataset fixture\ndefaultLocale: en-US\n",
  );
  await writeFile(
    path.join(worldRoot, "characters/characters.json"),
    JSON.stringify([{ id: "hero", name: "Hero", type: "npc" }]),
  );
  await writeFile(
    path.join(worldRoot, "data/lorebook.yaml"),
    "- id: lore\n  content: A valid world rule.\n",
  );
  const records = async (values: readonly unknown[]) =>
    writeFile(path.join(worldRoot, "data/notes.json"), JSON.stringify(values));
  await records([
    { id: "a", text: "before" },
    { id: "b", text: "before" },
  ]);
  const preflight = { registry, activePlugins: ["probe"] };
  const options = {
    sessionId: "dataset-session",
    worldId: "dataset-world",
    worldsDirs: [path.dirname(worldRoot)],
    now: DATASET_NOW,
    locale: "en-US",
    preflight,
  };
  const session = (id = options.sessionId) => ({
    id,
    worldId: options.worldId,
    locale: "en-US",
    status: "active" as const,
    phase: "playing" as const,
    setupRuntimes: {},
    seats: [
      {
        id: "main",
        controller: "human" as const,
        role: "player" as const,
        characters: "auto" as const,
      },
    ],
    completedPlayerTurns: 0,
    activePlugins: ["probe"],
    createdAt: DATASET_NOW,
    updatedAt: DATASET_NOW,
  });
  const prepare = () => prepareWorldDataImportForSession(options);
  const create = async (store: DataStore) => {
    const prepared = await prepare();
    await store.withTransaction(async (tx) => {
      await tx.createSession(session());
      await tx.upsertCharacterSchema({
        sessionId: options.sessionId,
        version: 1,
        types: ["npc"],
        attributes: [],
        createdAt: DATASET_NOW,
        updatedAt: DATASET_NOW,
      });
      await applyPreparedWorldDataImportForSession({
        store: tx,
        ...options,
        prepared,
      });
    });
    return prepared;
  };
  const sync = (
    store: DataStore,
    extra: Partial<Parameters<typeof syncWorldDataForSession>[0]> = {},
  ) => syncWorldDataForSession({ store, ...options, ...extra });
  const rows = (store: DataStore) =>
    store.listPluginData(options.sessionId, "probe", "notes");
  return {
    root,
    pluginRoot,
    worldRoot,
    registry,
    policy,
    records,
    options,
    session,
    prepare,
    create,
    sync,
    rows,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
