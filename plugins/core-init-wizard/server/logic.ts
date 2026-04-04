import type { DynamicFieldSchema } from "@covel/shared";

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
