import { randomUUID } from "node:crypto";
import { characterBlueprintToCharacterUpsert } from "@covel/shared";
import type { CharacterBlueprint } from "@covel/shared";
import type {
  CharacterRecord,
  LorebookEntryRecord,
  StoreTransaction,
} from "@covel/store";
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
  store: StoreTransaction,
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

/**
 * Import portable lorebook rows embedded in a generated WorldRecord.
 *
 * File-backed worlds use their worldData descriptor. Store-only and browser
 * worlds have no durable package directory, so the AI route carries the same
 * validated text rows in `metadata.embeddedLorebook` for this fallback.
 */
export async function importWorldEmbeddedLorebook(
  store: StoreTransaction,
  sessionId: string,
  worldId: string | undefined,
  now: string,
): Promise<void> {
  if (!worldId) return;
  const world = await store.getWorld(worldId);
  const candidates =
    isRecord(world?.metadata) && Array.isArray(world.metadata.embeddedLorebook)
      ? world.metadata.embeddedLorebook.slice(0, 128)
      : [];
  const seen = new Set<string>();
  const records: LorebookEntryRecord[] = [];
  for (const [index, value] of candidates.entries()) {
    if (!isRecord(value)) continue;
    if (typeof value.id !== "string" || !value.id || seen.has(value.id)) {
      continue;
    }
    if (typeof value.content !== "string" || !value.content) continue;
    seen.add(value.id);
    const keys = Array.isArray(value.keys)
      ? value.keys
          .filter((key): key is string => typeof key === "string")
          .slice(0, 32)
      : [];
    records.push({
      id: value.id,
      sessionId,
      pluginId: "world-data",
      keys,
      content: value.content,
      strategy: value.strategy === "selective" ? "selective" : "constant",
      position:
        value.position === "before_plugin" ? "before_plugin" : "after_plugin",
      insertionOrder:
        typeof value.insertionOrder === "number"
          ? value.insertionOrder
          : 100 + index,
      enabled: value.enabled !== false,
      ...(value.extra !== undefined ? { extra: value.extra } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }
  if (records.length > 0) {
    await store.upsertLorebookEntries(records);
  }
}
