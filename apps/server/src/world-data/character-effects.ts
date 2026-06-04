import {
  characterBlueprintToCharacterUpsert,
  type CharacterBlueprint,
} from "@covel/shared";
import type { CharacterRecord } from "@covel/store";

const CHARACTER_BLUEPRINT_NAMESPACE = "blueprints";
const CHARACTER_NAMESPACE = "characters";
const MAX_SCOPED_CHARACTER_ID_LENGTH = 180;

interface CharacterPluginDataTarget {
  readonly pluginId: string;
  readonly namespace: string;
}

interface CharacterDataSchemaDecl {
  readonly acceptsWorldData?: boolean;
}

interface CharacterPluginEntry {
  readonly dataSchemas?: Readonly<
    Record<string, CharacterDataSchemaDecl | undefined>
  >;
}

interface CharacterEffectsDeps {
  readonly activePlugins?: readonly string[];
  readonly registry?: {
    get(pluginId: string): CharacterPluginEntry | undefined;
  };
  readonly getPluginEntry?: (
    pluginId: string,
  ) => CharacterPluginEntry | undefined;
}

export interface CharacterMirrorTarget {
  readonly target: string;
  readonly pluginId: string;
  readonly namespace: typeof CHARACTER_NAMESPACE;
}

export interface BlueprintStorageTarget {
  readonly pluginId: string;
  readonly namespace: typeof CHARACTER_BLUEPRINT_NAMESPACE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeWorldCharacterBlueprint(
  value: unknown,
): CharacterBlueprint | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.name !== "string" || value.name.length === 0) return null;
  return value as unknown as CharacterBlueprint;
}

// A write targets a blueprint store when it lands in the conventional
// `blueprints` namespace — the framework keys on the namespace marker, never
// on a specific plugin id (mirrors the `characters` namespace convention used
// by `characterMirrorTargets`).
function characterBlueprintTarget(target: CharacterPluginDataTarget): boolean {
  return target.namespace === CHARACTER_BLUEPRINT_NAMESPACE;
}

export function scopedCharacterId(
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

export function characterBlueprintAdapter(options: {
  readonly target: CharacterPluginDataTarget;
  readonly value: unknown;
  readonly sessionId: string;
  readonly worldId: string;
  readonly sourceId: string;
  readonly now: string;
}): {
  readonly value: unknown;
  readonly blueprint: CharacterBlueprint | null;
} {
  const blueprint = normalizeWorldCharacterBlueprint(options.value);
  if (!characterBlueprintTarget(options.target)) {
    return { value: options.value, blueprint };
  }

  return {
    blueprint,
    value: {
      blueprint: options.value,
      importedAt: options.now,
      sourceWorldId: options.worldId,
      sourceId: options.sourceId,
      instantiatedCharacterId:
        blueprint !== null
          ? scopedCharacterId(options.sessionId, blueprint)
          : undefined,
    },
  };
}

export function characterRecordFromValue(
  sessionId: string,
  value: unknown,
  now: string,
): CharacterRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  if (!id || !name) return null;
  return {
    id,
    sessionId,
    name,
    type: typeof value.type === "string" ? value.type : "npc",
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(value.fields !== undefined ? { fields: value.fields } : {}),
    version: typeof value.version === "number" ? value.version : 1,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: now,
  };
}

function characterFromBlueprint(
  sessionId: string,
  blueprint: CharacterBlueprint,
  now: string,
): CharacterRecord {
  // Mirror target is data-driven: honour the blueprint's own
  // `instantiate.mirrorPluginId` when declared; the framework does not force a
  // specific plugin. Cross-plugin mirroring is handled separately by
  // `characterMirrorTargets` (capability discovery).
  const upsert = characterBlueprintToCharacterUpsert(blueprint, {
    now,
    characterId: scopedCharacterId(sessionId, blueprint),
  });
  return {
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
}

export function characterRecordForCharacterEffect(options: {
  readonly sessionId: string;
  readonly value: unknown;
  readonly now: string;
}): CharacterRecord | null {
  const blueprint = normalizeWorldCharacterBlueprint(options.value);
  if (blueprint) {
    return characterFromBlueprint(options.sessionId, blueprint, options.now);
  }
  return characterRecordFromValue(
    options.sessionId,
    options.value,
    options.now,
  );
}

function getPluginEntry(
  deps: CharacterEffectsDeps | undefined,
  pluginId: string,
): CharacterPluginEntry | undefined {
  return deps?.getPluginEntry?.(pluginId) ?? deps?.registry?.get(pluginId);
}

export function characterMirrorTargets(
  deps: CharacterEffectsDeps | undefined,
): readonly CharacterMirrorTarget[] {
  const activePlugins = deps?.activePlugins ?? [];
  return activePlugins.flatMap((pluginId) => {
    const schema = getPluginEntry(deps, pluginId)?.dataSchemas?.characters;
    if (schema?.acceptsWorldData !== true) return [];
    return [
      {
        target: `plugin:${pluginId}/${CHARACTER_NAMESPACE}`,
        pluginId,
        namespace: CHARACTER_NAMESPACE,
      },
    ];
  });
}

/**
 * Discover plugins that accept imported world character blueprints, by their
 * `dataSchemas.blueprints.acceptsWorldData` declaration — never by a hardcoded
 * plugin id. Mirrors `characterMirrorTargets` for the `blueprints` namespace.
 */
export function blueprintStorageTargets(
  deps: CharacterEffectsDeps | undefined,
): readonly BlueprintStorageTarget[] {
  const activePlugins = deps?.activePlugins ?? [];
  return activePlugins.flatMap((pluginId) => {
    const schema = getPluginEntry(deps, pluginId)?.dataSchemas?.[
      CHARACTER_BLUEPRINT_NAMESPACE
    ];
    if (schema?.acceptsWorldData !== true) return [];
    return [{ pluginId, namespace: CHARACTER_BLUEPRINT_NAMESPACE }];
  });
}
