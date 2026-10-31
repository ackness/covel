import {
  getPendingProposals,
  instructionLocaleFor,
  withModelView,
  getToolContent,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import {
  initializeCharacterSchema,
  createWorldAttributeSchema,
} from "../lib/initialize-character-schema.js";
import {
  initializeDimensionDefinitions,
  createDimensionDefinitionSchema,
} from "../lib/initialize-dimensions.js";

export default function (toolkit) {
  const { tool, z } = toolkit;
  return tool({
    name: "initialize-world",
    description:
      "Initialize character schema and dimension declarations together. Author declarations are authoritative; only a world without them needs generated definitions, and definitions sent for a world that has its own are not used. Never mirror global dimension values into character fields or lorebook.",
    parameters: z
      .strictObject({
        types: z.array(z.string().min(1)).default(["npc", "companion"]),
        attributes: z.array(createWorldAttributeSchema(z)).min(15),
        definitions: z
          .record(z.string(), createDimensionDefinitionSchema(z))
          .optional(),
      })
      .superRefine(({ attributes }, ctx) => {
        const categories = new Set(
          attributes.map((attribute) => attribute.category),
        );
        for (const category of [
          "stats",
          "bio",
          "abilities",
          "equipment",
          "social",
        ]) {
          if (!categories.has(category))
            ctx.addIssue({
              code: "custom",
              path: ["attributes"],
              message: `attributes must include category: ${category}`,
            });
        }
      }),
    execute: async ({ types, attributes, definitions }, ctx) => {
      const declared =
        ctx.world?.worldRecord?.dimensions ??
        ctx.world?.worldRecord?.metadata?.dimensions;
      // The world's own declarations are used as they are. The prompt cannot
      // tell the model whether the world has any, so a model often sends
      // definitions as well. Refusing them cost another model call at the
      // start of every session of such a world; they are left out instead.
      const schemaResult = initializeCharacterSchema(
        { types, attributes },
        ctx,
      );
      const dimensionsResult = initializeDimensionDefinitions(
        declared ?? definitions ?? {},
        ctx,
      );
      const schema = getToolContent(schemaResult);
      const dimensionCount = getToolContent(dimensionsResult).dimensionCount;
      const summary =
        instructionLocaleFor(ctx.locale) === "zh"
          ? `世界已初始化：${schema.attributeCount} 个属性，${dimensionCount} 个维度。`
          : `World initialized: ${schema.attributeCount} attributes, ${dimensionCount} dimensions.`;
      return withModelView(
        withPendingProposals(
          {
            success: true,
            preGameDone: true,
            worldSchema: schema.worldSchema,
            attributeCount: schema.attributeCount,
            dimensionCount,
          },
          [
            ...getPendingProposals(schemaResult),
            ...getPendingProposals(dimensionsResult),
          ],
        ),
        { summary },
      );
    },
  });
}
