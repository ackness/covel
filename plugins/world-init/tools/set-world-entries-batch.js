/**
 * set-world-entries-batch — Batch-write world entries (geography, factions, etc.).
 * Single call to create all entries, avoiding N separate tool calls.
 *
 * Data destinations (FU-8, S3-T2 follow-up):
 *   1. `plugin_data` namespace=entries — structured data mirror used by
 *      admin/debug surfaces.
 *   2. `lorebook_entries` (session-scoped, constant strategy) — prompt
 *      destination for world dimensions. Each entry becomes one `constant`
 *      lorebook row so the context loader can compose `world.entries`.
 *
 * The tool emits both writes as pending proposals so the kernel commits them
 * through the same transaction path as every other runtime side effect.
 *
 * @param {{ tool: Function, z: import('zod'), store: any }} injection
 */
import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";

export default function ({ tool, z, store }) {
  void store;
  return tool({
    name: "set-world-entries-batch",
    description:
      "Batch-write world entries. Pass all entries in a single call (geography, factions, currency, power system, etc.) instead of calling one by one. At least 5 entries.",
    parameters: z.object({
      entries: z
        .array(
          z.object({
            key: z
              .string()
              .min(1)
              .describe('Entry key (e.g. "geography", "factions", "currency")'),
            value: z
              .record(z.string(), z.unknown())
              .describe("Entry content (any JSON object)"),
          }),
        )
        .min(1)
        .describe("Array of world entries"),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();

      // 1) Legacy plugin_data write — unchanged read path for old sessions.
      const pluginDataItems = params.entries.map((entry) => ({
        namespace: "entries",
        key: entry.key,
        value: entry.value,
      }));

      // 2) Lorebook proposal — canonical destination for world dimensions.
      // Each entry becomes one `constant` lorebook row. The id is a
      // deterministic suffix of (sessionId, key) so re-runs replace rather
      // than duplicate. Spacing insertionOrder by 100 keeps room for
      // future interleaving without a full re-numbering.
      const lorebookEntries = params.entries.map((entry, idx) => ({
        id: `world-entry:${entry.key}`,
        keys: [entry.key],
        content: formatEntryContent(entry.key, entry.value),
        strategy: "constant",
        position: "after_char_defs",
        insertionOrder: 100 + idx * 100,
        enabled: true,
      }));

      return withPendingProposals(
        {
          success: true,
          count: pluginDataItems.length,
          keys: params.entries.map((e) => e.key),
        },
        [
          makeProposal(context, now, "plugin.data.batch", {
            items: pluginDataItems,
          }),
          makeProposal(context, now, "lorebook.upsert", {
            entries: lorebookEntries,
          }),
        ],
      );
    },
  });
}

/**
 * Render a world entry as a readable lorebook content block. The context
 * loader exposes these as `{{ world.entries }}`, so the content should be
 * self-describing (prefixed with the key) and stable across runs for
 * deterministic prompt assembly.
 */
function formatEntryContent(key, value) {
  let body;
  try {
    body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  return `[${key}]\n${body}`;
}
