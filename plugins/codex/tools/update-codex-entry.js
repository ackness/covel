/**
 * Plugin-local tool: update-codex-entry
 *
 * Update an existing codex entry with new information.
 * Reads from plugin-data store, merges new info, and writes back.
 * The entryId should be a short semantic ID returned by unlock-codex-entries
 * (e.g. 'codex-fire-magic', 'codex-3').
 *
 * Also (re-)attaches `categoryMeta` to the persisted `value`. New entries get
 * it via `unlock-codex-entries`; this update path acts as a backfill so
 * pre-existing entries written before B2 also gain the metadata.
 */

import { makeProposal } from "@covel/plugin-handlers-utils";
import { overlayPluginDataValue, withPendingProposals } from "@covel/tools";
import { getCategoryMetadata } from "../category-metadata.js";

export function createCodexUpdateSchema(z) {
  return z.object({
    entryId: z
      .string()
      .min(1)
      .describe("Short ID of the entry to update (e.g. codex-fire-magic)"),
    appendContent: z.string().min(1).describe("New content to append"),
    newTags: z.array(z.string()).optional().describe("Tags to add"),
    rarityUpgrade: z
      .enum(["common", "uncommon", "rare", "legendary"])
      .optional()
      .describe("Set if a new discovery upgrades the rarity"),
  });
}

export default function ({ tool, z }) {
  return tool({
    name: "update-codex-entry",
    description:
      "Update an existing codex entry by appending newly discovered information. Use the short entryId returned by unlock-codex-entries (e.g. codex-fire-magic).",
    parameters: createCodexUpdateSchema(z),
    execute: async (params, context) => {
      const now = new Date().toISOString();

      // Composite tools can add proposals between direct calls to this helper;
      // those local additions are newer than the executor's read snapshot.
      const pending = overlayPluginDataValue(
        context.pendingProposals ?? [],
        context.pluginId,
        "entries",
        params.entryId,
      );
      const existing = pending.hit
        ? pending.deleted
          ? null
          : { value: pending.value }
        : await context.store.getPluginData("entries", params.entryId);

      if (!existing) {
        return { updated: false, error: `Entry ${params.entryId} not found` };
      }

      // Merge updates into existing entry. Preserve any prior `categoryMeta`
      // (no category change happens on update) but backfill it from the
      // plugin-local metadata table when the existing entry pre-dates B2.
      const oldValue = existing.value;
      const updatedValue = {
        ...oldValue,
        categoryMeta:
          oldValue.categoryMeta ?? getCategoryMetadata(oldValue.category),
        content: `${oldValue.content}\n\n${params.appendContent}`,
        tags: mergeTags(oldValue.tags, params.newTags),
        rarity: params.rarityUpgrade ?? oldValue.rarity,
        updatedAt: now,
      };

      return withPendingProposals(
        {
          updated: true,
          entryId: params.entryId,
          appendedContent: params.appendContent,
          ui: [
            {
              type: "ui-spec",
              entryId: params.entryId,
              spec: {
                type: "EntryCard",
                props: {
                  title: updatedValue.title,
                  category: updatedValue.category,
                  content: params.appendContent,
                  tags: params.newTags ?? [],
                  rarity: updatedValue.rarity,
                },
              },
              meta: {
                entryId: params.entryId,
                rarityUpgrade: params.rarityUpgrade,
              },
            },
          ],
        },
        [
          makeProposal(context, now, "plugin.data", {
            namespace: "entries",
            key: params.entryId,
            value: updatedValue,
          }),
        ],
      );
    },
  });
}

function mergeTags(existing, newTags) {
  if (!newTags || newTags.length === 0) return existing ?? [];
  const set = new Set([...(existing ?? []), ...newTags]);
  return [...set].slice(0, 10);
}
