import { resolveI18nText } from "@covel/plugin-handlers-utils";
import { resolveI18nDeep } from "@covel/plugin-handlers-utils";
import {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionIdSchema,
  dimensionRecordSchema,
  dimensionSettlementReceiptSchema,
} from "@covel/plugin-handlers-utils/dimensions";
import { schemaForTracker } from "../lib/schema-for-tracker.js";

/** Tracker-only adopted rules, paged so large schemas never flood a model prompt. */
export default function ({ tool, z }) {
  return tool({
    name: "dimension-rule-get",
    description:
      "Read a complete adopted updateRule or value schema for maintenance. Follow nextOffset until complete; do not settle from a truncated rule. Uses the source receipt's frozen definitions when retrying.",
    parameters: z.strictObject({
      id: dimensionIdSchema,
      part: z.enum(["rule", "schema"]),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(6000).default(6000),
    }),
    execute: async ({ id, part, offset, limit }, ctx) => {
      const narrative = ctx.inputSlots?.narrative;
      if (narrative?.cardinality !== "one")
        throw new Error("Narrative provenance required");
      const row = await ctx.store.getPluginData(DIMENSION_DATA_NAMESPACE, id);
      if (!row) throw new Error(`Unknown dimension: ${id}`);
      const record = dimensionRecordSchema.parse(row.value);
      if (record.version !== ctx.world.dimensions[id]?.version)
        throw new Error("dimension-version-conflict");
      const receiptRow = await ctx.store.getPluginData(
        DIMENSION_SETTLEMENT_NAMESPACE,
        narrative.source.resultId,
      );
      const receipt = receiptRow
        ? dimensionSettlementReceiptSchema.parse(receiptRow.value)
        : undefined;
      const definition = receipt?.definitions[id] ?? record.definition;
      const session = await ctx.store.getSession();
      const text =
        part === "rule"
          ? (resolveI18nText(definition.updateRule, session.locale) ?? "")
          : JSON.stringify(
              schemaForTracker(
                resolveI18nDeep(definition.schema, session.locale),
              ),
            );
      const characters = Array.from(text);
      const content = characters.slice(offset, offset + limit).join("");
      const complete = offset + limit >= characters.length;
      return {
        id,
        version: record.version,
        content,
        complete,
        ...(!complete ? { nextOffset: offset + limit } : {}),
        _text: JSON.stringify({
          id,
          version: record.version,
          content,
          complete,
          ...(!complete ? { nextOffset: offset + limit } : {}),
        }),
      };
    },
  });
}
