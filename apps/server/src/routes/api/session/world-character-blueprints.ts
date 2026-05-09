import { randomUUID } from "node:crypto";
import { characterBlueprintToCharacterUpsert } from "@covel/shared";
import type { CharacterBlueprint } from "@covel/shared";
import type { DataStore } from "@covel/store";

const WORLD_BLUEPRINT_PLUGIN_ID = "character-blueprint";
const WORLD_BLUEPRINT_NAMESPACE = "blueprints";
const CHARACTER_PANEL_PLUGIN_ID = "char-creator";
const MAX_SCOPED_CHARACTER_ID_LENGTH = 180;

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

export async function importWorldCharacterBlueprints(
  store: DataStore,
  sessionId: string,
  worldId: string | undefined,
  now: string,
): Promise<void> {
  if (!worldId) return;
  const world = await store.getWorld(worldId);
  const rawBlueprints =
    isRecord(world?.metadata) &&
    Array.isArray(world.metadata.characterBlueprints)
      ? world.metadata.characterBlueprints
      : [];
  const blueprints = rawBlueprints
    .map(normalizeWorldCharacterBlueprint)
    .filter((blueprint): blueprint is CharacterBlueprint => blueprint !== null);
  if (blueprints.length === 0) return;

  const pluginRecords = blueprints.map((blueprint) => {
    const upsert = characterBlueprintToCharacterUpsert(blueprint, {
      now,
      characterId: worldBlueprintCharacterId(sessionId, blueprint),
      mirrorPluginId: WORLD_BLUEPRINT_PLUGIN_ID,
    });
    return {
      id: randomUUID(),
      sessionId,
      pluginId: WORLD_BLUEPRINT_PLUGIN_ID,
      namespace: WORLD_BLUEPRINT_NAMESPACE,
      key: blueprint.id,
      value: {
        blueprint,
        importedAt: now,
        sourceWorldId: worldId,
        instantiatedCharacterId: upsert.id,
      },
      createdAt: now,
      updatedAt: now,
    };
  });
  await store.setPluginDataBatch(pluginRecords);

  for (const blueprint of blueprints) {
    const upsert = characterBlueprintToCharacterUpsert(blueprint, {
      now,
      characterId: worldBlueprintCharacterId(sessionId, blueprint),
      mirrorPluginId: WORLD_BLUEPRINT_PLUGIN_ID,
    });
    const characterRecord = {
      id: upsert.id,
      sessionId,
      name: upsert.name,
      type: upsert.type ?? "npc",
      ...(upsert.description !== undefined
        ? { description: upsert.description }
        : {}),
      ...(upsert.fields !== undefined ? { fields: upsert.fields } : {}),
      version: upsert.version ?? 1,
      createdAt: upsert.createdAt ?? now,
      updatedAt: now,
    };
    await store.upsertCharacter(characterRecord);
    await store.setPluginData({
      id: randomUUID(),
      sessionId,
      pluginId: WORLD_BLUEPRINT_PLUGIN_ID,
      namespace: "characters",
      key: characterRecord.id,
      value: characterRecord,
      createdAt: now,
      updatedAt: now,
    });
    await store.setPluginData({
      id: randomUUID(),
      sessionId,
      pluginId: CHARACTER_PANEL_PLUGIN_ID,
      namespace: "characters",
      key: characterRecord.id,
      value: characterRecord,
      createdAt: now,
      updatedAt: now,
    });
  }
}
