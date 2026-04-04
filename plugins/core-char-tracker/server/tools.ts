import type { ToolExecutionContext, ToolExecutionResult, CharacterCard, DynamicFieldSchema } from "@covel/shared";
import { PLUGIN_ID, type TrackerExtension } from "./logic.js";

function getCharacterMap(
  state: Record<string, unknown> | undefined,
): Record<string, CharacterCard> {
  const chars = state?.characters;
  if (chars && typeof chars === "object" && !Array.isArray(chars)) {
    return { ...(chars as Record<string, CharacterCard>) };
  }
  return {};
}

function getSchema(
  state: Record<string, unknown> | undefined,
): DynamicFieldSchema | undefined {
  return state?.characterFieldSchema as DynamicFieldSchema | undefined;
}

/**
 * Sanitize field values against the schema, keeping only known keys.
 */
function sanitizeFields(
  fields: Record<string, unknown>,
  schema: DynamicFieldSchema,
): Record<string, unknown> {
  const knownKeys = new Set(schema.fields.map((f) => f.key));
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (knownKeys.has(k)) {
      result[k] = v;
    }
  }
  return result;
}

export async function upsertCharacterTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as {
    name: string;
    description: string;
    type: "npc" | "companion";
    fields?: Record<string, unknown>;
  };

  if (!input.name?.trim()) {
    return {
      output: {
        error: isZh ? "角色名字不能为空。" : "Character name is required.",
      },
    };
  }

  const schema = getSchema(ctx.state);
  const characters = getCharacterMap(ctx.state);
  const existing = characters[input.name];

  const inputFields = input.fields ?? {};
  const sanitizedFields = schema
    ? sanitizeFields(inputFields, schema)
    : inputFields;

  let card: CharacterCard;

  if (existing) {
    // Update existing character
    const ext = (existing.extensions[PLUGIN_ID] ?? {}) as TrackerExtension;
    const updatedExt: TrackerExtension = {
      ...ext,
      lastSeenTurn: (ctx.state?.turnId as string) ?? "",
      mentionCount: (ext.mentionCount ?? 0) + 1,
    };
    card = {
      ...existing,
      description: input.description || existing.description,
      type: input.type || existing.type,
      fields: Object.keys(sanitizedFields).length > 0
        ? { ...existing.fields, ...sanitizedFields }
        : existing.fields,
      extensions: {
        ...existing.extensions,
        [PLUGIN_ID]: updatedExt,
      },
      version: existing.version + 1,
    };
  } else {
    // Create new character
    const trackerExt: TrackerExtension = {
      firstSeenTurn: (ctx.state?.turnId as string) ?? "",
      lastSeenTurn: (ctx.state?.turnId as string) ?? "",
      mentionCount: 1,
    };
    card = {
      id: "",
      worldId: (ctx.state?.worldId as string) ?? "",
      runId: (ctx.state?.runId as string) ?? "",
      name: input.name,
      type: input.type,
      description: input.description,
      fields: sanitizedFields,
      extensions: {
        [PLUGIN_ID]: trackerExt,
      },
      createdAt: new Date().toISOString(),
      version: 1,
    };
  }

  characters[input.name] = card;

  return {
    output: {
      message: isZh
        ? existing
          ? `已更新角色「${card.name}」。`
          : `已创建角色「${card.name}」(${card.type})。`
        : existing
          ? `Updated character "${card.name}".`
          : `Created character "${card.name}" (${card.type}).`,
      name: card.name,
      isNew: !existing,
    },
    proposals: [
      {
        kind: "record.upsert",
        payload: {
          key: `character:${card.name}`,
          value: {
            recordType: "character",
            fields: { ...card },
          },
        },
      },
      {
        kind: "state.patch",
        payload: { characters },
      },
    ],
  };
}
