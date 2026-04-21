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

import { withPendingProposals } from '@covel/tools';
import { getCategoryMetadata } from '../category-metadata.js';

export default function ({ tool, z, store }) {
  return tool({
    name: 'update-codex-entry',
    description: '更新已有的图鉴条目，追加新发现的信息。entryId 使用 unlock-codex-entries 返回的短 ID（如 codex-fire-magic）。',
    parameters: z.object({
      entryId: z.string().min(1).describe('要更新的条目短 ID（如 codex-fire-magic）'),
      appendContent: z.string().min(1).describe('追加的新内容'),
      newTags: z.array(z.string()).optional().describe('新增的标签'),
      rarityUpgrade: z.enum(['common', 'uncommon', 'rare', 'legendary']).optional()
        .describe('如果有新发现提升了稀有度'),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();

      // Read existing entry from plugin-data store
      const existing = await store.getPluginData(
        context.sessionId,
        context.pluginId,
        'entries',
        params.entryId,
      );

      if (!existing) {
        return { updated: false, error: `Entry ${params.entryId} not found` };
      }

      // Merge updates into existing entry. Preserve any prior `categoryMeta`
      // (no category change happens on update) but backfill it from the
      // plugin-local metadata table when the existing entry pre-dates B2.
      const oldValue = existing.value;
      const updatedValue = {
        ...oldValue,
        categoryMeta: oldValue.categoryMeta ?? getCategoryMetadata(oldValue.category),
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
          ui: [{
            type: 'ui-spec',
            entryId: params.entryId,
            spec: {
              type: 'EntryCard',
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
          }],
        },
        [{
          id: crypto.randomUUID(),
          type: 'plugin.data',
          source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
          turnId: context.turnId,
          sessionId: context.sessionId,
          payload: {
            namespace: 'entries',
            key: params.entryId,
            value: updatedValue,
          },
          timestamp: now,
        }],
      );
    },
  });
}

function mergeTags(existing, newTags) {
  if (!newTags || newTags.length === 0) return existing ?? [];
  const set = new Set([...(existing ?? []), ...newTags]);
  return [...set].slice(0, 10);
}
