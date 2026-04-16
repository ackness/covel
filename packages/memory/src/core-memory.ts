/**
 * Core Memory Manager — CRUD for editable memory blocks.
 *
 * Maps core memory blocks to the `working_memory` table:
 *   scope = 'story', key = block label, value = { text: string }
 *
 * This is the in-context tier: blocks are injected into every runtime's prompt
 * and updated post-turn by the MemoryUpdater.
 */

import type { DataStore } from '@covel/store';
import type {
  CoreMemoryBlock,
  CoreMemoryConfig,
  CoreMemoryLabel,
  MemoryManager,
} from './types.js';
import { CORE_MEMORY_LABELS, DEFAULT_MAX_BLOCK_CHARS } from './types.js';

const SCOPE = 'story' as const;

export function createMemoryManager(
  store: DataStore,
  config?: CoreMemoryConfig,
): MemoryManager {
  const labels = config?.labels ?? CORE_MEMORY_LABELS;
  const maxChars = config?.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;

  function toBlock(record: { key: string; value: unknown; updatedAt: string }): CoreMemoryBlock {
    const raw = record.value as { text?: string } | string | null;
    const content = typeof raw === 'string'
      ? raw
      : (raw?.text ?? '');
    return {
      label: record.key as CoreMemoryLabel,
      content,
      updatedAt: record.updatedAt,
    };
  }

  return {
    async loadBlocks(sessionId: string): Promise<readonly CoreMemoryBlock[]> {
      const all = await store.listWorkingMemory(sessionId);
      const blockMap = new Map<string, CoreMemoryBlock>();

      for (const record of all) {
        if (record.scope === SCOPE && labels.includes(record.key as CoreMemoryLabel)) {
          blockMap.set(record.key, toBlock(record));
        }
      }

      // Return in canonical order, with empty blocks for missing labels
      return labels.map((label) => blockMap.get(label) ?? {
        label,
        content: '',
        updatedAt: new Date().toISOString(),
      });
    },

    async getBlock(sessionId: string, label: CoreMemoryLabel): Promise<CoreMemoryBlock | null> {
      const record = await store.getWorkingMemory(sessionId, SCOPE, label);
      return record ? toBlock(record) : null;
    },

    async updateBlock(sessionId: string, label: CoreMemoryLabel, content: string): Promise<void> {
      const truncated = content.length > maxChars ? content.slice(0, maxChars) : content;
      const now = new Date().toISOString();

      await store.upsertWorkingMemory({
        id: `core-memory:${sessionId}:${label}`,
        sessionId,
        key: label,
        scope: SCOPE,
        value: { text: truncated },
        updatedAt: now,
      });

      // Mirror to plugin-data so the core-memory UI panel (json-render) can
      // read it via dataSource.namespace = 'blocks'. This triggers
      // plugin-data.changed SSE events for real-time panel updates.
      await mirrorToPluginData(store, sessionId, label, truncated, now);
    },

    async updateBlocks(sessionId: string, updates: ReadonlyMap<CoreMemoryLabel, string>): Promise<void> {
      const now = new Date().toISOString();

      const promises: Promise<void>[] = [];
      for (const [label, content] of updates) {
        const truncated = content.length > maxChars ? content.slice(0, maxChars) : content;
        promises.push(
          store.upsertWorkingMemory({
            id: `core-memory:${sessionId}:${label}`,
            sessionId,
            key: label,
            scope: SCOPE,
            value: { text: truncated },
            updatedAt: now,
          }),
        );
        promises.push(mirrorToPluginData(store, sessionId, label, truncated, now));
      }
      await Promise.all(promises);
    },

    async initializeDefaults(sessionId: string): Promise<void> {
      const existing = await store.listWorkingMemory(sessionId);
      const existingKeys = new Set(
        existing
          .filter((r) => r.scope === SCOPE)
          .map((r) => r.key),
      );

      const now = new Date().toISOString();
      const promises: Promise<void>[] = [];

      for (const label of labels) {
        if (!existingKeys.has(label)) {
          promises.push(
            store.upsertWorkingMemory({
              id: `core-memory:${sessionId}:${label}`,
              sessionId,
              key: label,
              scope: SCOPE,
              value: { text: '' },
              updatedAt: now,
            }),
          );
        }
      }

      if (promises.length > 0) await Promise.all(promises);
    },
  };
}

const PLUGIN_ID = 'core-memory';
const PLUGIN_DATA_NS = 'blocks';

/**
 * Mirror a core memory block to plugin-data so the json-render UI panel
 * can read it via `dataSource.namespace = 'blocks'`.
 *
 * This triggers `plugin-data.changed` SSE events when the store is
 * wrapped with the event proxy (see bootstrap.ts), enabling real-time
 * panel updates without polling.
 */
async function mirrorToPluginData(
  store: DataStore,
  sessionId: string,
  label: string,
  content: string,
  now: string,
): Promise<void> {
  try {
    await store.setPluginData({
      id: `core-memory-pd:${sessionId}:${label}`,
      sessionId,
      pluginId: PLUGIN_ID,
      namespace: PLUGIN_DATA_NS,
      key: label,
      value: content,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // Non-fatal: UI panel won't update in real-time but core memory still works
  }
}
