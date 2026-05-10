import type { CharacterAttributeSchema } from "@covel/shared";
import { z, type ZodType } from "zod";
import { buildFieldsZodFromSchema } from "../schema-to-zod.js";

/**
 * Minimal store interface needed by the character tools. Kept local to avoid
 * a runtime dependency on `@covel/store` from this package.
 */
export interface CharacterStore {
  upsertCharacter(record: {
    id: string;
    sessionId: string;
    name: string;
    type: string;
    description?: string;
    fields?: unknown;
    version: number;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  listCharacters(sessionId: string): Promise<
    ReadonlyArray<{
      id: string;
      sessionId: string;
      name: string;
      type: string;
      description?: string;
      fields?: unknown;
      version: number;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  setPluginData(record: {
    id: string;
    sessionId: string;
    pluginId: string;
    namespace: string;
    key: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  /**
   * Fetch a single plugin-data row. Used to load the character-attribute
   * schema for soft validation during create/update. Optional so existing
   * test stores that don't provide it gracefully skip validation.
   */
  getPluginData?(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<{ value: unknown; updatedAt: string } | null>;
  /** Optional — reserved for future use; create-character no longer calls this. */
  updateSession?(
    id: string,
    patch: {
      status?: "active" | "paused" | "ended";
      turnCount?: number;
      preGameCompleted?: readonly string[];
      activePlugins?: readonly string[];
      updatedAt?: string;
    },
  ): Promise<void>;
}

/**
 * Factory-level dependencies. Kept as a separate bag so the ctor stays
 * positional and existing test call sites (which pass only a store) still
 * work — schema validation silently becomes a no-op when the plugin
 * resolver isn't provided.
 */
export interface CharacterToolDeps {
  /**
   * Resolve the active plugin package id that holds the character-attribute
   * schema for this session. Injected so `@covel/tools` stays free of a
   * runtime dependency on `@covel/plugin-loader` (same pattern as
   * `createWorldDimensionTools`). Return `undefined` to skip validation.
   */
  findWorldDataPluginId?(sessionId: string): string | undefined;
}

export const CHARACTER_NAMESPACE = "characters";

export const characterTypeSchema = z
  .enum(["player", "npc", "companion"])
  .describe("角色类型：player=玩家，npc=NPC，companion=同伴");

export interface CharacterSnapshot {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: unknown;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toSnapshot(record: {
  id: string;
  name: string;
  type: string;
  description?: string;
  fields?: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}): CharacterSnapshot {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    description: record.description,
    fields: record.fields,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Load the character-attribute schema for this session, if any. Returns
 * `null` when the store can't read plugin-data, no world-data plugin is
 * resolved, or the schema hasn't been written yet. Any error swallows to
 * `null` — validation is a best-effort UX hint, never a failure path.
 */
export async function loadCharacterSchema(
  store: CharacterStore,
  deps: CharacterToolDeps,
  sessionId: string,
): Promise<CharacterAttributeSchema | null> {
  if (typeof store.getPluginData !== "function") return null;
  const worldPluginId = deps.findWorldDataPluginId?.(sessionId);
  if (!worldPluginId) return null;
  try {
    const row = await store.getPluginData(
      sessionId,
      worldPluginId,
      "schema",
      "character-attributes",
    );
    if (!row) return null;
    const value = row.value;
    if (!value || typeof value !== "object") return null;
    const shape = value as { version?: unknown; attributes?: unknown };
    if (!Array.isArray(shape.attributes)) return null;
    return value as CharacterAttributeSchema;
  } catch {
    return null;
  }
}

export async function mirrorCharacterToPluginData(
  store: CharacterStore,
  sessionId: string,
  pluginId: string,
  character: CharacterSnapshot,
): Promise<void> {
  const now = new Date().toISOString();
  await store.setPluginData({
    id: `char-mirror-${character.id}`,
    sessionId,
    pluginId,
    namespace: CHARACTER_NAMESPACE,
    key: character.id,
    value: character,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Format an attribute record as a one-line "key: value" string. Arrays of
 * primitives are joined with ", " and objects are JSON-stringified compactly.
 */
export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const allPrimitive = value.every(
      (v) =>
        v === null ||
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean",
    );
    return allPrimitive ? `[${value.join(", ")}]` : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

export function formatFields(fields: unknown): string[] {
  if (!fields || typeof fields !== "object") return [];
  return Object.entries(fields as Record<string, unknown>).map(
    ([k, v]) => `  ${k}: ${formatFieldValue(v)}`,
  );
}

/**
 * Truncate a long description to the first `maxLen` characters for compact
 * list output. Preserves the full description in the detailed `get-character`
 * response.
 */
export function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/**
 * Sort characters for list-characters output.
 *
 * Primary key: version descending (higher version = more updates =
 * higher involvement frequency — LLM plugins bump version each time they
 * interact with a character).
 *
 * Secondary key: updatedAt descending (more recent = closer to the current
 * turn). Ties in frequency are broken by recency so the most recently
 * touched character surfaces first within the same version band.
 */
export function sortByFrequencyThenRecency<
  T extends { version: number; updatedAt: string },
>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * Build the `fields` Zod field for create/update-character parameters.
 * When `schema` is provided the fields are strongly typed per attribute id
 * (LLM sees named keys with correct types); otherwise falls back to a
 * permissive record so storytelling isn't blocked before schema-gen runs.
 */
export function buildFieldsZod(
  schema: CharacterAttributeSchema | null,
): ZodType {
  const typed = schema ? buildFieldsZodFromSchema(schema) : null;
  return typed ?? z.record(z.string(), z.unknown());
}
