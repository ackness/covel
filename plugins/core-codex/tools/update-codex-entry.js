/**
 * Plugin-local tool: update-codex-entry
 *
 * Update an existing codex entry with new information.
 * Reads from plugin-data store, merges new info, and writes back.
 * The entryId should be a short semantic ID returned by unlock-codex-entries
 * (e.g. 'codex-fire-magic', 'codex-3').
 */

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

      // Merge updates into existing entry
      const oldValue = existing.value;
      const updatedValue = {
        ...oldValue,
        content: `${oldValue.content}\n\n${params.appendContent}`,
        tags: mergeTags(oldValue.tags, params.newTags),
        rarity: params.rarityUpgrade ?? oldValue.rarity,
        updatedAt: now,
      };

      await store.setPluginData({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        pluginId: context.pluginId,
        namespace: 'entries',
        key: params.entryId,
        value: updatedValue,
        createdAt: existing.updatedAt ?? now,
        updatedAt: now,
      });

      return {
        updated: true,
        entryId: params.entryId,
        appendedContent: params.appendContent,
        ui: [{
          type: 'codex-update',
          entryId: params.entryId,
          appendedContent: params.appendContent,
          rarityUpgrade: params.rarityUpgrade,
          style: {
            animation: params.rarityUpgrade ? 'upgrade-pulse' : 'subtle-glow',
          },
        }],
      };
    },
  });
}

function mergeTags(existing, newTags) {
  if (!newTags || newTags.length === 0) return existing ?? [];
  const set = new Set([...(existing ?? []), ...newTags]);
  return [...set].slice(0, 10);
}
