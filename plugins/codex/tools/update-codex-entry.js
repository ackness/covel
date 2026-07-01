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

import { withPendingProposals } from "@covel/tools";
import { getCategoryMetadata } from "../category-metadata.js";

export default function ({ tool, z, store }) {
  return tool({
    name: "update-codex-entry",
    description:
      "Update an existing codex entry by appending newly discovered information. Use the short entryId returned by unlock-codex-entries (e.g. codex-fire-magic).",
    parameters: z.object({
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
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();

      const existing =
        getPendingEntry(context.pendingProposals, context, params.entryId) ??
        (await store.getPluginData(
          context.sessionId,
          context.pluginId,
          "entries",
          params.entryId,
        ));

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
          {
            id: crypto.randomUUID(),
            type: "plugin.data",
            source: {
              pluginId: context.pluginId,
              runtimeId: context.runtimeId,
            },
            turnId: context.turnId,
            sessionId: context.sessionId,
            payload: {
              namespace: "entries",
              key: params.entryId,
              value: updatedValue,
            },
            timestamp: now,
          },
        ],
      );
    },
  });
}

function getPendingEntry(pendingProposals, context, entryId) {
  if (!Array.isArray(pendingProposals) || pendingProposals.length === 0) {
    return null;
  }

  for (let i = pendingProposals.length - 1; i >= 0; i--) {
    const proposal = pendingProposals[i];
    if (!proposal || proposal.sessionId !== context.sessionId) continue;
    if (proposal.source?.pluginId !== context.pluginId) continue;

    if (proposal.type === "plugin.data") {
      if (
        proposal.payload?.namespace !== "entries" ||
        proposal.payload?.key !== entryId
      )
        continue;
      return { value: proposal.payload.value };
    }

    if (proposal.type === "plugin.data.batch") {
      const item = proposal.payload?.items?.find?.(
        (candidate) =>
          candidate.namespace === "entries" && candidate.key === entryId,
      );
      if (item) {
        return { value: item.value };
      }
    }
  }

  return null;
}

function mergeTags(existing, newTags) {
  if (!newTags || newTags.length === 0) return existing ?? [];
  const set = new Set([...(existing ?? []), ...newTags]);
  return [...set].slice(0, 10);
}
