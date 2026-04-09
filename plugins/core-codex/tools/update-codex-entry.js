/**
 * Plugin-local tool: update-codex-entry
 *
 * Update an existing codex entry with new information.
 */

export default function ({ tool, z }) {
  return tool({
    name: 'update-codex-entry',
    description: '更新已有的图鉴条目，追加新发现的信息。',
    parameters: z.object({
      entryId: z.string().min(1).describe('要更新的条目 ID'),
      appendContent: z.string().min(1).describe('追加的新内容'),
      newTags: z.array(z.string()).optional().describe('新增的标签'),
      rarityUpgrade: z.enum(['common', 'uncommon', 'rare', 'legendary']).optional()
        .describe('如果有新发现提升了稀有度'),
    }),
    execute: async (params) => {
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
