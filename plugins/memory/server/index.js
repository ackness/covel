import { resolveI18nText } from "@covel/plugin-handlers-utils";
import { DEFAULT_CORE_MEMORY_BLOCKS } from "./blocks.js";
const escapeXml = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

import { DEFINITIONS_CONTRACT } from "./definitions.js";

export default function register(covel) {
  const { z } = covel.toolkit;
  const i18n = z.union([z.string(), z.record(z.string(), z.string())]);
  covel.registerService({
    name: "block-definitions",
    contract: DEFINITIONS_CONTRACT,
    input: z.object({}),
    output: z.array(
      z.object({
        label: z.string().min(1),
        displayName: i18n,
        extractionHint: i18n,
        icon: z.string().optional(),
        maxChars: z.number().int().positive().optional(),
      }),
    ),
    handler: () => DEFAULT_CORE_MEMORY_BLOCKS,
  });
  covel.provideExtension("prompt.segment@1", "memory", {
    async handler(_input, ctx) {
      const rows = await ctx.pluginData.list("blocks");
      const nonEmpty = rows
        .filter(
          (row) =>
            typeof row.value?.content === "string" && row.value.content.trim(),
        )
        .sort((a, b) => a.key.localeCompare(b.key))
        .slice(0, 60);
      const maxChars = Math.min(
        2000,
        Math.floor(8192 / Math.max(1, nonEmpty.length)),
      );
      return nonEmpty.map((row) => ({
        id: row.key,
        content: `<memory-block>\n# ${escapeXml(resolveI18nText(row.value.displayName, ctx.locale) ?? row.key)}\n${escapeXml(row.value.content.slice(0, maxChars))}\n</memory-block>`,
        position: "system",
        audience: "story",
        volatility: "turn",
        order: 0,
      }));
    },
  });
}
