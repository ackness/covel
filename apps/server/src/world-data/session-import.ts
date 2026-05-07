import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  characterBlueprintToCharacterUpsert,
  type CharacterBlueprint,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import { loadWorldDataDescriptor } from "./descriptor.js";
import { readWorldDataSource } from "./source-reader.js";
import { parseWorldDataTarget } from "./target-uri.js";
import type { OrderedWorldDataSource } from "./types.js";

const WORLD_BLUEPRINT_PLUGIN_ID = "character-blueprint";
const WORLD_BLUEPRINT_NAMESPACE = "blueprints";
const CHARACTER_PANEL_PLUGIN_ID = "char-creator";
const MAX_SCOPED_CHARACTER_ID_LENGTH = 180;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeWorldCharacterBlueprint(
  value: unknown,
): CharacterBlueprint | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.name !== "string" || value.name.length === 0) return null;
  return value as unknown as CharacterBlueprint;
}

function sourceItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

function worldBlueprintCharacterId(
  sessionId: string,
  blueprint: CharacterBlueprint,
): string {
  const baseId =
    typeof blueprint.instantiate?.characterId === "string" &&
    blueprint.instantiate.characterId.length > 0
      ? blueprint.instantiate.characterId
      : `char-${blueprint.id}`;
  const scopedId = `${sessionId}-${baseId}`;
  return scopedId.length <= MAX_SCOPED_CHARACTER_ID_LENGTH
    ? scopedId
    : `${sessionId}-${blueprint.id}`;
}

async function readWorldManifest(worldRoot: string): Promise<{
  id?: string;
  worldData?: string;
}> {
  const raw = parseYaml(
    await readFile(path.join(worldRoot, "world.yaml"), "utf-8"),
  );
  return isRecord(raw)
    ? {
        id: typeof raw.id === "string" ? raw.id : undefined,
        worldData:
          typeof raw.worldData === "string" ? raw.worldData : undefined,
      }
    : {};
}

async function resolveWorldRoot(
  worldId: string,
  worldsDirs: readonly string[],
): Promise<string | null> {
  for (const worldsDir of [...worldsDirs].reverse()) {
    const candidate = path.join(worldsDir, worldId);
    if (!(await fileExists(path.join(candidate, "world.yaml")))) continue;
    const manifest = await readWorldManifest(candidate);
    if (manifest.id === worldId) return candidate;
  }
  return null;
}

function shouldImportBlueprintSource(source: OrderedWorldDataSource): boolean {
  const target = parseWorldDataTarget(source.descriptor.to);
  return (
    target?.kind === "plugin-data" &&
    target.pluginId === WORLD_BLUEPRINT_PLUGIN_ID &&
    target.namespace === WORLD_BLUEPRINT_NAMESPACE
  );
}

async function importBlueprintSource(options: {
  store: DataStore;
  sessionId: string;
  worldId: string;
  source: OrderedWorldDataSource;
  now: string;
}): Promise<void> {
  const read = await readWorldDataSource(options.source);
  if (read.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    throw new Error(
      `failed to read worldData source "${options.source.id}": ${read.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }
  const blueprints = sourceItems(read.value)
    .map(normalizeWorldCharacterBlueprint)
    .filter((blueprint): blueprint is CharacterBlueprint => blueprint !== null);
  if (blueprints.length === 0) return;

  await options.store.setPluginDataBatch(
    blueprints.map((blueprint) => {
      const characterId = worldBlueprintCharacterId(
        options.sessionId,
        blueprint,
      );
      return {
        id: randomUUID(),
        sessionId: options.sessionId,
        pluginId: WORLD_BLUEPRINT_PLUGIN_ID,
        namespace: WORLD_BLUEPRINT_NAMESPACE,
        key: blueprint.id,
        value: {
          blueprint,
          importedAt: options.now,
          sourceWorldId: options.worldId,
          sourceId: options.source.id,
          instantiatedCharacterId: characterId,
        },
        createdAt: options.now,
        updatedAt: options.now,
      };
    }),
  );

  if (!options.source.descriptor.effects?.includes("characters")) return;

  for (const blueprint of blueprints) {
    const upsert = characterBlueprintToCharacterUpsert(blueprint, {
      now: options.now,
      characterId: worldBlueprintCharacterId(options.sessionId, blueprint),
      mirrorPluginId: WORLD_BLUEPRINT_PLUGIN_ID,
    });
    const characterRecord = {
      id: upsert.id,
      sessionId: options.sessionId,
      name: upsert.name,
      type: upsert.type ?? "npc",
      ...(upsert.description !== undefined
        ? { description: upsert.description }
        : {}),
      ...(upsert.fields !== undefined ? { fields: upsert.fields } : {}),
      version: upsert.version ?? 1,
      createdAt: upsert.createdAt ?? options.now,
      updatedAt: options.now,
    };
    await options.store.upsertCharacter(characterRecord);
    for (const pluginId of [
      WORLD_BLUEPRINT_PLUGIN_ID,
      CHARACTER_PANEL_PLUGIN_ID,
    ]) {
      await options.store.setPluginData({
        id: randomUUID(),
        sessionId: options.sessionId,
        pluginId,
        namespace: "characters",
        key: characterRecord.id,
        value: characterRecord,
        createdAt: options.now,
        updatedAt: options.now,
      });
    }
  }
}

export async function importWorldDataForSession(options: {
  store: DataStore;
  sessionId: string;
  worldId: string | undefined;
  worldsDirs?: readonly string[];
  covelHome?: string;
  now: string;
}): Promise<boolean> {
  if (!options.worldId || !options.worldsDirs?.length) return false;
  const worldRoot = await resolveWorldRoot(options.worldId, options.worldsDirs);
  if (!worldRoot) return false;
  const manifest = await readWorldManifest(worldRoot);
  if (!manifest.worldData) return false;

  const descriptor = await loadWorldDataDescriptor({
    worldRoot,
    worldId: options.worldId,
    worldDataPath: manifest.worldData,
    covelHome: options.covelHome,
  });
  const errors = descriptor.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  if (errors.length > 0) {
    throw new Error(
      `invalid worldData descriptor for "${options.worldId}": ${errors
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }

  for (const source of descriptor.sources) {
    if (shouldImportBlueprintSource(source)) {
      await importBlueprintSource({
        ...options,
        worldId: options.worldId,
        source,
      });
    }
  }
  return true;
}
