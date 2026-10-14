import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { worldDimensionsSchema } from "@covel/plugin-handlers-utils/dimensions";

export function createDimensionDefinitionSchema(z) {
  const text = z.union([z.string().min(1), z.record(z.string(), z.string())]);
  return z.strictObject({
    name: text,
    description: text.optional(),
    schema: z
      .record(z.string(), z.unknown())
      .describe(
        "Closed JSON Schema subset: type, properties, required, additionalProperties, items, enum, const, numeric/string/array bounds, title (string or locale map), description, x-i18n, x-enumLabels (display labels keyed by enum member). Unknown keywords are rejected.",
      ),
    initialValue: z
      .unknown()
      .describe("JSON value matching schema; no coercion or default filling."),
    updateRule: text
      .optional()
      .describe(
        "Only explicit nonempty rules enable automatic tracking. State that requires uncertain or inferred facts must remain unchanged.",
      ),
  });
}

export function initializeDimensionDefinitions(definitions, context) {
  const parsed = worldDimensionsSchema.parse(definitions);
  return withPendingProposals(
    { success: true, dimensionCount: Object.keys(parsed).length },
    [
      makeProposal(context, new Date().toISOString(), "dimension.initialize", {
        definitions: parsed,
      }),
    ],
  );
}
