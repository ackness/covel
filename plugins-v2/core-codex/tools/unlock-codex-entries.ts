/**
 * Plugin-local tool: unlock-codex-entries
 *
 * Batch unlock multiple codex entries in one call.
 * Produces a rich "discovery" UI card for each new entry.
 */

import { z } from 'zod';
import { tool } from '../../../packages/tools/src/tool.js';

const codexEntrySchema = z.object({
  category: z.enum(['monster', 'item', 'location', 'lore', 'character', 'skill'])
    .describe('知识类别'),
  title: z.string().min(1).describe('条目标题'),
  content: z.string().min(10).describe('2-3 句话的描述'),
  tags: z.array(z.string()).min(1).max(5).describe('标签列表'),
  rarity: z.enum(['common', 'uncommon', 'rare', 'legendary']).default('common')
    .describe('稀有度，影响 UI 展示样式'),
  imageHint: z.string().optional()
    .describe('可选的视觉描述提示，用于后续图像生成'),
});

export const unlockCodexEntriesTool = tool({
  name: 'unlock-codex-entries',
  description: '批量解锁新的图鉴条目。每个条目会生成一张"知识发现"卡片展示给玩家。',
  parameters: z.object({
    entries: z.array(codexEntrySchema).min(1).describe('要解锁的图鉴条目列表'),
  }),
  execute: async (params, context) => {
    // Each entry produces a discovery UI card
    const results = params.entries.map((entry, i) => ({
      entryId: `codex-${context.sessionId}-${Date.now()}-${i}`,
      ...entry,
      unlockedAt: new Date().toISOString(),
    }));

    // Generate UI render instructions for discovery cards
    const ui = results.map((entry) => ({
      type: 'codex-discovery' as const,
      entryId: entry.entryId,
      category: entry.category,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
      rarity: entry.rarity,
      imageHint: entry.imageHint,
      // Visual styling hints based on rarity
      style: {
        borderColor: rarityColor(entry.rarity),
        icon: categoryIcon(entry.category),
        animation: entry.rarity === 'legendary' ? 'glow' : entry.rarity === 'rare' ? 'shimmer' : 'fade-in',
      },
    }));

    return {
      unlocked: results.length,
      entries: results,
      ui,
    };
  },
});

function rarityColor(rarity: string): string {
  switch (rarity) {
    case 'legendary': return '#ff8c00';
    case 'rare': return '#a855f7';
    case 'uncommon': return '#3b82f6';
    default: return '#6b7280';
  }
}

function categoryIcon(category: string): string {
  switch (category) {
    case 'monster': return '🐉';
    case 'item': return '⚔️';
    case 'location': return '🗺️';
    case 'lore': return '📜';
    case 'character': return '👤';
    case 'skill': return '✨';
    default: return '📖';
  }
}
