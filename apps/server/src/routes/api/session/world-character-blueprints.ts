import { randomUUID } from "node:crypto";
import { characterBlueprintToCharacterUpsert } from "@covel/shared";
import type { CharacterBlueprint } from "@covel/shared";
import type { CharacterRecord, DataStore } from "@covel/store";
import {
  blueprintStorageTargets,
  characterMirrorTargets,
  normalizeWorldCharacterBlueprint,
  scopedCharacterId,
} from "../../../world-data/character-effects.js";
import type { WorldDataImportPreflightDeps } from "../../../world-data/session-import/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fallback world-character import for worlds that declare inline
 * `metadata.characterBlueprints` (rather than worldData source descriptors).
 *
 * Mirrors the capability-driven handling in `world-data/session-import`:
 *  - blueprint definitions land in every plugin that declares
 *    `dataSchemas.blueprints.acceptsWorldData` (discovered, never hardcoded);
 *  - the canonical `CharacterRecord` is the source of truth panels read via
 *    `session.characters`;
 *  - the character is mirrored into every plugin that declares
 *    `dataSchemas.characters.acceptsWorldData`.
 *
 * When no provider is active, the corresponding writes simply skip — removing
 * a plugin never makes this path throw.
 */
export async function importWorldCharacterBlueprints(
  store: DataStore,
  sessionId: string,
  worldId: string | undefined,
  now: string,
  deps?: WorldDataImportPreflightDeps,
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

  // Discover targets by capability — never by plugin id.
  const blueprintTargets = blueprintStorageTargets(deps);
  const mirrorTargets = characterMirrorTargets(deps);

  const planned = blueprints.map((blueprint) => {
    const upsert = characterBlueprintToCharacterUpsert(blueprint, {
      now,
      characterId: scopedCharacterId(sessionId, blueprint),
    });
    const characterRecord: CharacterRecord = {
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
    return { blueprint, characterRecord };
  });

  // 1) Store blueprint definitions in every blueprint-accepting plugin.
  const blueprintRecords = planned.flatMap(({ blueprint, characterRecord }) =>
    blueprintTargets.map((target) => ({
      id: randomUUID(),
      sessionId,
      pluginId: target.pluginId,
      namespace: target.namespace,
      key: blueprint.id,
      value: {
        blueprint,
        importedAt: now,
        sourceWorldId: worldId,
        instantiatedCharacterId: characterRecord.id,
      },
      createdAt: now,
      updatedAt: now,
    })),
  );
  if (blueprintRecords.length > 0) {
    await store.setPluginDataBatch(blueprintRecords);
  }

  // 2) Canonical character + 3) capability-discovered mirrors.
  for (const { characterRecord } of planned) {
    await store.upsertCharacter(characterRecord);
    for (const target of mirrorTargets) {
      await store.setPluginData({
        id: randomUUID(),
        sessionId,
        pluginId: target.pluginId,
        namespace: target.namespace,
        key: characterRecord.id,
        value: characterRecord,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}
