import {
  getPendingProposals,
  getToolContent,
  withPendingProposals,
} from "@covel/tools";
import makeSetWorldSchema, {
  createWorldAttributeSchema,
} from "./set-world-schema.js";
import makeSetWorldEntriesBatch, {
  createWorldEntrySchema,
} from "./set-world-entries-batch.js";

export default function (toolkit) {
  const { tool, z } = toolkit;
  const setWorldSchema = makeSetWorldSchema(toolkit);
  const setWorldEntriesBatch = makeSetWorldEntriesBatch(toolkit);
  const requiredCategories = [
    "stats",
    "bio",
    "abilities",
    "equipment",
    "social",
  ];

  return tool({
    name: "initialize-world",
    description:
      "Atomically initialize this session's character attribute schema and world reference entries. Submit exactly once with at least 15 attributes across all five categories and at least 5 world entries.",
    parameters: z
      .object({
        attributes: z
          .array(createWorldAttributeSchema(z))
          .min(15)
          .describe(
            "Character attributes covering stats, bio, abilities, equipment, and social mechanics.",
          ),
        entries: z
          .array(createWorldEntrySchema(z))
          .min(5)
          .describe(
            "World reference entries such as geography, factions, currency, power system, and social structure.",
          ),
      })
      .superRefine(({ attributes }, refinementContext) => {
        const actualCategories = new Set(
          attributes.map((attribute) => attribute.category),
        );
        for (const category of requiredCategories) {
          if (!actualCategories.has(category)) {
            refinementContext.addIssue({
              code: "custom",
              path: ["attributes"],
              message: `attributes must include category: ${category}`,
            });
          }
        }
      }),
    execute: async ({ attributes, entries }, context) => {
      const schemaResult = await setWorldSchema.execute(
        { attributes },
        context,
      );
      const schemaProposals = getPendingProposals(schemaResult);
      const entriesResult = await setWorldEntriesBatch.execute(
        { entries },
        {
          ...context,
          pendingProposals: [
            ...(context.pendingProposals ?? []),
            ...schemaProposals,
          ],
        },
      );

      const schemaOutput = getToolContent(schemaResult);
      const entriesOutput = getToolContent(entriesResult);

      return withPendingProposals(
        {
          success: true,
          attributeCount: schemaOutput.attributeCount,
          categories: schemaOutput.categories,
          count: entriesOutput.count,
          keys: entriesOutput.keys,
          worldSchema: schemaOutput.worldSchema,
          preGameDone: true,
        },
        [...schemaProposals, ...getPendingProposals(entriesResult)],
      );
    },
  });
}
