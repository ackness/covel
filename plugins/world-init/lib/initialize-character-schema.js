import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";

export function createWorldAttributeSchema(z) {
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
      min: z
        .number()
        .optional()
        .describe(
          "Lowest value of a number attribute. Set both `min` and `max` on every stat that rises and falls within a range (health, stamina, stress); the interface shows a gauge only when both are set",
        ),
      max: z
        .number()
        .optional()
        .describe("Highest value of a number attribute; set it with `min`"),
      defaultValue: z
        .unknown()
        .optional()
        .describe(
          "Starting value for every new, unnamed character, not an example NPC. Use neutral or empty identity values (name, role, background); never copy a specific character from the lore. Put identity fields in bio. Generated bio text/compound defaults are cleared and bio enum defaults are omitted; numeric and boolean defaults remain.",
        ),
      itemType: z
        .enum(["string", "number"])
        .optional()
        .describe(
          "Array element type (required when type=array). Use an array of strings in the `equipment` category for what the character carries",
        ),
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
        .describe(
          "Attribute category. bio: name, role, background and other identity fields. stats: meters such as health or stress, shown as bars. abilities: what dice checks and point buy use (strength, perception…). social: relationships such as trust. equipment: what the character carries",
        ),
      description: i18nText
        .optional()
        .describe("Attribute description (string or i18n record)"),
    }),
  );

  return attributeSchema;
}

/**
 * Generated schemas describe any new character, never the biography of one
 * person in the lore. Author-provided schemas go through guard.js unchanged.
 * Clear biography values by type instead of guessing names from prose or IDs.
 */
function neutralBiographyDefaults(attributes, inBiography = false) {
  return attributes.map((attribute) => {
    const biography = inBiography || attribute.category === "bio";
    const normalized = { ...attribute };
    if (attribute.subSchema)
      normalized.subSchema = neutralBiographyDefaults(
        attribute.subSchema,
        biography,
      );
    if (biography && Object.hasOwn(attribute, "defaultValue")) {
      switch (attribute.type) {
        case "string":
          normalized.defaultValue = "";
          break;
        case "enum":
          // An empty string need not be one of the options. No choice is
          // safer than assigning every new character one NPC's affiliation.
          delete normalized.defaultValue;
          break;
        case "array":
          normalized.defaultValue = [];
          break;
        case "object":
        case "map":
          normalized.defaultValue = {};
          break;
      }
    }
    return normalized;
  });
}

export function initializeCharacterSchema(params, context) {
  const worldSchema = {
    types: params.types ?? ["npc", "companion"],
    attributes: neutralBiographyDefaults(params.attributes),
  };
  return withPendingProposals(
    { success: true, attributeCount: params.attributes.length, worldSchema },
    [
      makeProposal(
        context,
        new Date().toISOString(),
        "character.schema.set",
        worldSchema,
      ),
    ],
  );
}
