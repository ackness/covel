/**
 * set-world-schema — Store character attribute schema for this world.
 * Single call to define all character attributes at once.
 *
 * @param {{ tool: Function, z: import('zod') }} injection
 */
import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";

export default function ({ tool, z }) {
  // A display label is either a plain string or an i18n record
  // (`{ "zh-CN": "门派", "en-US": "Faction" }`). The LLM normally emits a plain
  // string; a world that ships its own schema may declare bilingual labels.
  const i18nText = z.union([
    z.string().min(1),
    z.record(z.string(), z.string()),
  ]);

  // Recursive: an `object` attribute can carry `subSchema`, which itself is
  // an array of AttributeDefinition. Zod 4 still exposes `z.lazy(fn)` for
  // self-referential schemas; the `/** @type {z.ZodTypeAny} */` annotation
  // keeps inference happy in a plain .js file.
  /** @type {z.ZodType} */
  const attributeSchema = z.lazy(() =>
    z.object({
      id: z
        .string()
        .min(1)
        .describe('Unique attribute ID (e.g. "hp", "level", "skills")'),
      name: i18nText.describe("Attribute display name (string or i18n record)"),
      type: z
        .enum(["string", "number", "array", "enum", "boolean", "object", "map"])
        .describe("Attribute data type"),
      min: z.number().optional().describe("Minimum value for number types"),
      max: z.number().optional().describe("Maximum value for number types"),
      defaultValue: z.unknown().optional().describe("Default value"),
      itemType: z
        .enum(["string", "number"])
        .optional()
        .describe("Array element type (required when type=array)"),
      options: z
        .array(z.string())
        .optional()
        .describe("Enum options (required when type=enum)"),
      subSchema: z
        .array(attributeSchema)
        .optional()
        .describe(
          "Nested attribute definitions (required when type=object; describes the object's internal structure)",
        ),
      valueType: z
        .enum(["string", "number", "boolean"])
        .optional()
        .describe(
          "Map value type (optional when type=map; defaults to string)",
        ),
      category: z
        .enum(["stats", "bio", "abilities", "equipment", "social"])
        .describe("Attribute category"),
      description: i18nText
        .optional()
        .describe("Attribute description (string or i18n record)"),
    }),
  );

  return tool({
    name: "set-world-schema",
    description:
      "Define the world's character attribute schema. Pass all attribute definitions in a single call. Supported types: string | number (may set min/max/defaultValue) | boolean | enum (needs options) | array (needs itemType) | object (needs subSchema to describe sub-fields) | map (optional valueType). Cover at least the core mechanics that recur throughout the worldbuilding document.",
    parameters: z.object({
      attributes: z
        .array(attributeSchema)
        .min(1)
        .describe("Array of character attribute definitions"),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      const worldSchema = {
        "character-attributes": {
          version: 1,
          attributes: params.attributes,
        },
      };
      return withPendingProposals(
        {
          success: true,
          attributeCount: params.attributes.length,
          categories: [...new Set(params.attributes.map((a) => a.category))],
          worldSchema,
        },
        [
          makeProposal(context, now, "plugin.data", {
            namespace: "schema",
            key: "character-attributes",
            value: worldSchema["character-attributes"],
          }),
        ],
      );
    },
  });
}
