/**
 * Plugin-local tool: unlock-codex-entries
 *
 * Batch unlock multiple codex entries in one call.
 * Persists to plugin-data store and produces a rich "discovery" UI card.
 *
 * Uses shortIdBatch() to generate LLM-friendly IDs like 'codex-fire-magic'
 * instead of UUID-based IDs. LLM can reference these IDs in update-codex-entry.
 *
 * Each persisted entry's `value` is enriched with a `categoryMeta` field
 * (icon / color / displayName) sourced from the plugin-local
 * `category-metadata.js`. This lets the UI (json-render spec) render
 * category badges without any framework-side lookup table.
 */

import { getCategoryMetadata } from '../category-metadata.js';

export default function ({ tool, z, shortIdBatch, store }) {
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

  return tool({
    name: 'unlock-codex-entries',
    description: '批量解锁新的图鉴条目。条目会持久化存储并生成"知识发现"卡片。返回的 entryId（如 codex-fire-magic）可用于后续 update-codex-entry 调用。',
    parameters: z.object({
      entries: z.array(codexEntrySchema).min(1).describe('要解锁的图鉴条目列表'),
    }),
    execute: async (params, context) => {
      const ids = shortIdBatch('codex', params.entries.map((e) => e.title), context.sessionId);
      const now = new Date().toISOString();

      const results = params.entries.map((entry, i) => ({
        entryId: ids[i],
        ...entry,
        unlockedAt: now,
      }));

      // Persist all entries to plugin-data store. The persisted `value`
      // self-describes its category via `categoryMeta` so the UI doesn't
      // need a framework-side category lookup table.
      //
      // `isNew: true` flags a fresh unlock so the UI can decorate the card
      // (generic EntryCard prop). This panel keeps the NEW badge on
      // indefinitely — there is no session-scoped "clear NEW" mechanism
      // yet; downstream plugins can extend this if needed.
      const records = results.map((entry) => ({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        pluginId: context.pluginId,
        namespace: 'entries',
        key: entry.entryId,
        value: {
          category: entry.category,
          categoryMeta: getCategoryMetadata(entry.category),
          title: entry.title,
          content: entry.content,
          tags: entry.tags,
          rarity: entry.rarity,
          imageHint: entry.imageHint,
          unlockedAt: entry.unlockedAt,
          isNew: true,
        },
        createdAt: now,
        updatedAt: now,
      }));
      await store.setPluginDataBatch(records);

      const ui = results.map((entry) => ({
        type: 'codex-discovery',
        entryId: entry.entryId,
        category: entry.category,
        title: entry.title,
        content: entry.content,
        tags: entry.tags,
        rarity: entry.rarity,
        imageHint: entry.imageHint,
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
}

function rarityColor(rarity) {
  switch (rarity) {
    case 'legendary': return '#ff8c00';
    case 'rare': return '#a855f7';
    case 'uncommon': return '#3b82f6';
    default: return '#6b7280';
  }
}

function categoryIcon(category) {
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
