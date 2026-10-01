import { z } from "zod";
import {
  dimensionQuerySchema,
  queryDimensionSnapshot,
  type I18nText,
  type DimensionValueSchema,
} from "@covel/shared";
import { tool } from "../tool.js";

/** Public reads use the same frozen turn snapshot for every calling plugin. */
export const worldDimensionGetTool = tool({
  name: "world-dimension-get",
  description:
    "Read current versioned world dimensions. Paths select inside value (dot/brackets or JSON Pointer); offset/limit pages strings and collections. No initial-value or own-write preview fallback.",
  parameters: dimensionQuerySchema,
  execute: async (params, ctx) => {
    if (!ctx.world?.dimensions)
      throw new Error("Dimension snapshot unavailable");
    const session = await ctx.store?.getSession();
    return queryDimensionSnapshot(
      ctx.world.dimensions,
      params,
      z.object({ locale: z.string().optional() }).parse(session ?? {}).locale,
    );
  },
});

interface DimensionListing {
  dimensions: {
    id: string;
    name: I18nText;
    type: DimensionValueSchema["type"];
    version: number;
  }[];
  _text: string;
}
export const worldDimensionListTool = tool({
  name: "world-dimension-list",
  description:
    "Discover author-defined dimension IDs, names, types and current versions without dumping values or rules.",
  parameters: z.strictObject({}),
  execute: async (_params, ctx): Promise<DimensionListing> => {
    if (!ctx.world?.dimensions)
      throw new Error("Dimension snapshot unavailable");
    return {
      dimensions: Object.entries(ctx.world.dimensions).map(([id, entry]) => ({
        id,
        name: entry.name,
        type: entry.schema.type,
        version: entry.version,
      })),
      _text: Object.entries(ctx.world.dimensions)
        .map(
          ([id, entry]) =>
            `${id} (v${entry.version}): ${JSON.stringify(entry.schema.type ?? "JSON")}`,
        )
        .join("\n"),
    };
  },
});
