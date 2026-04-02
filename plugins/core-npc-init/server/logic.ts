import type { FieldDefinition, DynamicFieldSchema } from "@covel/shared";

const PLUGIN_ID = "core-npc-init";

// ── Schema validation ────────────────────────────────────────────

const VALID_TYPES = new Set(["number", "string", "boolean", "enum", "text"]);
const VALID_CATEGORIES = new Set(["stats", "bio", "equipment", "social", "custom"]);

export function validateFieldDefinitions(
  fields: unknown[],
): { valid: FieldDefinition[]; errors: string[] } {
  const errors: string[] = [];
  const valid: FieldDefinition[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i] as Record<string, unknown>;
    const key = raw.key as string | undefined;
    const label = raw.label as string | undefined;
    const type = raw.type as string | undefined;

    if (!key || !label || !type) {
      errors.push(`Field #${i}: missing key/label/type`);
      continue;
    }

    if (seenKeys.has(key)) {
      errors.push(`Field #${i}: duplicate key "${key}"`);
      continue;
    }

    if (!VALID_TYPES.has(type)) {
      errors.push(`Field #${i}: invalid type "${type}"`);
      continue;
    }

    if (type === "enum" && (!Array.isArray(raw.options) || raw.options.length === 0)) {
      errors.push(`Field #${i}: enum type requires non-empty options array`);
      continue;
    }

    const category = raw.category as string | undefined;
    if (category && !VALID_CATEGORIES.has(category)) {
      errors.push(`Field #${i}: invalid category "${category}"`);
      continue;
    }

    seenKeys.add(key);
    valid.push({
      key,
      label,
      type: type as FieldDefinition["type"],
      options: type === "enum" ? (raw.options as string[]) : undefined,
      defaultValue: raw.defaultValue,
      category: category as FieldDefinition["category"],
      visible: raw.visible !== false,
      min: typeof raw.min === "number" ? raw.min : undefined,
      max: typeof raw.max === "number" ? raw.max : undefined,
    });
  }

  return { valid, errors };
}

export function buildSchema(
  worldId: string,
  fields: FieldDefinition[],
): DynamicFieldSchema {
  return {
    version: 1,
    worldId,
    fields,
    createdAt: new Date().toISOString(),
  };
}

// ── NPC card building ────────────────────────────────────────────

export interface NpcInput {
  name: string;
  description: string;
  type: "npc" | "companion";
  fields: Record<string, unknown>;
}

export interface NpcCard {
  id: string;
  worldId: string;
  runId: string;
  name: string;
  type: "npc" | "companion";
  description: string;
  fields: Record<string, unknown>;
  extensions: Record<string, unknown>;
  createdAt: string;
  version: number;
}

let npcSeq = 0;

export function buildNpcCard(
  input: NpcInput,
  worldId: string,
  runId: string,
): NpcCard {
  npcSeq++;
  return {
    id: `npc_${Date.now()}_${npcSeq}`,
    worldId,
    runId,
    name: input.name,
    type: input.type,
    description: input.description,
    fields: { ...input.fields },
    extensions: {
      [PLUGIN_ID]: {
        source: "world_lore",
        initializedAt: new Date().toISOString(),
      },
    },
    createdAt: new Date().toISOString(),
    version: 1,
  };
}

/**
 * Validate NPC fields against the schema.
 * Returns sanitized fields with defaults applied.
 */
export function sanitizeNpcFields(
  fields: Record<string, unknown>,
  schema: DynamicFieldSchema,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const def of schema.fields) {
    const value = fields[def.key];

    if (value !== undefined && value !== null) {
      result[def.key] = value;
    } else if (def.defaultValue !== undefined) {
      result[def.key] = def.defaultValue;
    }
    // omit fields with no value and no default
  }

  return result;
}
