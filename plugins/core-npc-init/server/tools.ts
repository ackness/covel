import type { ToolExecutionContext, ToolExecutionResult } from "@covel/shared";
import type { DynamicFieldSchema } from "@covel/shared";
import { z } from "zod";
import {
  validateFieldDefinitions,
  buildSchema,
  buildNpcCard,
  sanitizeNpcFields,
  type NpcInput,
  type NpcCard,
} from "./logic.js";

// ── Zod Schemas ─────────────────────────────────────────────────

const defineCharacterSchemaInputSchema = z.object({
  fields: z.array(z.unknown()),
});

const createNpcInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(["npc", "companion"]),
  fields: z.record(z.string(), z.unknown()).optional(),
});

const finalizeInitInputSchema = z.object({
  summary: z.string(),
  npcCount: z.number(),
});

// ── Helpers ───────────────────────────────────────────────────────

function getCharacterMap(
  state: Record<string, unknown> | undefined,
): Record<string, NpcCard> {
  const chars = state?.characters;
  if (chars && typeof chars === "object" && !Array.isArray(chars)) {
    return { ...(chars as Record<string, NpcCard>) };
  }
  return {};
}

function getSchema(
  state: Record<string, unknown> | undefined,
): DynamicFieldSchema | undefined {
  return state?.characterFieldSchema as DynamicFieldSchema | undefined;
}

// ── define-character-schema ──────────────────────────────────────

export async function defineCharacterSchemaTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const parsed = defineCharacterSchemaInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return { output: { error: parsed.error.message } };
  }
  const { fields } = parsed.data;

  const { valid, errors } = validateFieldDefinitions(fields);

  if (valid.length === 0) {
    return {
      output: {
        error: isZh
          ? `字段定义无效：${errors.join("; ")}`
          : `Invalid field definitions: ${errors.join("; ")}`,
      },
    };
  }

  // Use worldId from context state or fallback
  const worldId = (ctx.state?.worldId as string) ?? "unknown";
  const schema = buildSchema(worldId, valid);

  const warnings = errors.length > 0
    ? (isZh ? `（${errors.length} 个字段被跳过）` : ` (${errors.length} field(s) skipped)`)
    : "";

  return {
    output: {
      message: isZh
        ? `已定义角色字段 schema，共 ${valid.length} 个字段${warnings}。`
        : `Character field schema defined with ${valid.length} fields${warnings}.`,
      fieldCount: valid.length,
      fields: valid.map((f) => f.key),
    },
    proposals: [
      {
        kind: "state.patch",
        payload: { characterFieldSchema: schema },
      },
      {
        kind: "record.upsert",
        payload: {
          key: "schema:character-fields",
          value: {
            recordType: "field_schema",
            fields: schema,
          },
        },
      },
    ],
  };
}

// ── create-npc ───────────────────────────────────────────────────

export async function createNpcTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as NpcInput;
  const schema = getSchema(ctx.state);

  if (!input.name || !input.description) {
    return {
      output: {
        error: isZh
          ? "NPC 名字和描述不能为空。"
          : "NPC name and description are required.",
      },
    };
  }

  const worldId = (ctx.state?.worldId as string) ?? "unknown";
  const runId = (ctx.state?.runId as string) ?? "unknown";

  // Sanitize fields against schema if available
  const sanitizedFields = schema
    ? sanitizeNpcFields(input.fields ?? {}, schema)
    : (input.fields ?? {});

  const card = buildNpcCard(
    { ...input, fields: sanitizedFields },
    worldId,
    runId,
  );

  // Merge into existing characters map (immutable)
  const characters = getCharacterMap(ctx.state);
  const updatedCharacters = { ...characters, [card.name]: card };

  return {
    output: {
      message: isZh
        ? `已创建 NPC「${card.name}」(${card.type})。`
        : `Created NPC "${card.name}" (${card.type}).`,
      npcId: card.id,
      name: card.name,
    },
    proposals: [
      {
        kind: "record.upsert",
        payload: {
          key: `character:${card.name}`,
          value: {
            recordType: "character",
            fields: {
              ...card,
            },
          },
        },
      },
      {
        kind: "state.patch",
        payload: { characters: updatedCharacters },
      },
    ],
  };
}

// ── finalize-init ────────────────────────────────────────────────

export async function finalizeInitTool(
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const isZh = ctx.locale.startsWith("zh");
  const input = ctx.input as { summary: string; npcCount: number };

  return {
    output: {
      message: isZh
        ? `NPC 初始化完成：${input.summary}`
        : `NPC initialization complete: ${input.summary}`,
    },
    proposals: [
      {
        kind: "state.patch",
        payload: {
          "core-npc-init": {
            initialized: true,
            npcCount: input.npcCount,
            summary: input.summary,
            completedAt: new Date().toISOString(),
          },
        },
      },
      {
        kind: "event.emit",
        payload: {
          type: "npcs_initialized",
          npcCount: input.npcCount,
          summary: input.summary,
        },
      },
      {
        kind: "ui.render",
        payload: {
          type: "npc_init_summary",
          content: {
            npcCount: input.npcCount,
            summary: input.summary,
            completedAt: new Date().toISOString(),
          },
        },
      },
    ],
  };
}
