import { resolve } from "node:path";
import type { CharacterCreateInput, DynamicFieldSchema } from "@covel/shared";
import { loadPrompt, interpolate } from "@covel/context";

const PROMPTS_DIR = resolve(import.meta.dirname, "../prompts");

/**
 * Build a prompt asking the LLM to write a narrative transition
 * from the opening story into a character name question.
 */
export async function buildTransitionPrompt(
  narrative: string,
  locale: string,
): Promise<string> {
  const template = await loadPrompt(PROMPTS_DIR, "transition-prompt", locale);
  return interpolate(template, { narrative });
}

/**
 * Return a static fallback transition when LLM is unavailable.
 */
export function buildFallbackTransition(locale: string): string {
  const isZh = locale.startsWith("zh");
  return isZh
    ? "在这一切开始之前——你叫什么名字？"
    : "Before all this begins — what is your name?";
}

/**
 * Build the character creation UI block proposal payload.
 * If a DynamicFieldSchema is available (from core-npc-init),
 * includes "bio" category fields for richer character creation.
 */
export function buildCharacterCreationBlock(
  locale: string,
  schema?: DynamicFieldSchema,
): {
  kind: string;
  payload: unknown;
} {
  const isZh = locale.startsWith("zh");

  const fields: Array<{
    id: string;
    type: string;
    label: string;
    placeholder?: string;
    required?: boolean;
    options?: string[];
    min?: number;
    max?: number;
    defaultValue?: unknown;
  }> = [
    {
      id: "character_name",
      type: "text",
      label: isZh ? "你的名字" : "Your Name",
      placeholder: isZh ? "键入你的名字..." : "Type your name...",
      required: true,
    },
  ];

  const submitMapping: Record<string, string> = {
    character_name: "name",
  };

  // Add bio fields from schema if available
  if (schema) {
    const bioFields = schema.fields.filter(
      (f) => f.category === "bio" && f.visible !== false,
    );
    for (const def of bioFields) {
      fields.push({
        id: `field_${def.key}`,
        type: def.type === "enum" ? "select" : def.type,
        label: def.label,
        options: def.options,
        min: def.min,
        max: def.max,
        defaultValue: def.defaultValue,
      });
      submitMapping[`field_${def.key}`] = `fields.${def.key}`;
    }
  }

  return {
    kind: "ui.render",
    payload: {
      type: "character_creation",
      content: {
        fields,
        submitLabel: isZh ? "确认" : "Confirm",
        submitMapping,
      },
    },
  };
}
