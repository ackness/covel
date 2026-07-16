/**
 * Core Memory Manager — CRUD for editable memory blocks.
 *
 * Maps core memory blocks to the `working_memory` table:
 *   scope = 'story', key = block label, value = { text: string }
 *
 * This is the in-context tier: blocks are injected into every runtime's prompt
 * and updated post-turn by the MemoryUpdater.
 *
 * The set of managed blocks (labels, display names, icons, per-block caps) is
 * **schema-driven** — supplied via {@link CoreMemoryConfig.blocks} and
 * defaulting to {@link DEFAULT_CORE_MEMORY_BLOCKS}. The manager never hardcodes
 * a block vocabulary, so any plugin/world can define its own blocks.
 */

import type { I18nText } from "@covel/shared";
import type { DataStore, WorkingMemoryRecord } from "@covel/store";
import type {
  CoreMemoryBlock,
  CoreMemoryBlockSchema,
  CoreMemoryConfig,
  CoreMemoryLabel,
  MemoryManager,
} from "./types.js";
import {
  DEFAULT_CORE_MEMORY_BLOCKS,
  DEFAULT_MAX_BLOCK_CHARS,
} from "./types.js";

const SCOPE = "story" as const;

export function createMemoryManager(
  store: DataStore,
  config?: CoreMemoryConfig,
): MemoryManager {
  const staticSchema = config?.blocks ?? DEFAULT_CORE_MEMORY_BLOCKS;
  const defaultMaxChars = config?.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;
  const mirrorPluginId = config?.pluginId;

  // Resolve the block schema for a session: the bootstrap-injected resolver
  // (plugin blocks merged with the session's world blocks) when present, else
  // the static schema. Derivation helpers are rebuilt per call so world-declared
  // blocks render and extract for the sessions that actually use them.
  const resolveSchema = async (
    sessionId: string,
  ): Promise<readonly CoreMemoryBlockSchema[]> =>
    (await config?.resolveBlocks?.(sessionId)) ?? staticSchema;

  interface SchemaHelpers {
    readonly labels: readonly string[];
    readonly maxCharsFor: (label: string) => number;
    readonly displayNameFor: (label: string) => I18nText;
    readonly iconFor: (label: string) => string;
  }

  function helpersFor(schema: readonly CoreMemoryBlockSchema[]): SchemaHelpers {
    const byLabel = new Map<string, CoreMemoryBlockSchema>(
      schema.map((b) => [b.label, b]),
    );
    return {
      labels: schema.map((b) => b.label),
      maxCharsFor: (label) => byLabel.get(label)?.maxChars ?? defaultMaxChars,
      displayNameFor: (label) =>
        byLabel.get(label)?.displayName ?? { zh: label, en: label },
      iconFor: (label) => byLabel.get(label)?.icon ?? "Info",
    };
  }

  function toBlock(
    record: { key: string; value: unknown; updatedAt: string },
    h: SchemaHelpers,
  ): CoreMemoryBlock {
    const raw = record.value as { text?: string } | string | null;
    const content = typeof raw === "string" ? raw : (raw?.text ?? "");
    return {
      label: record.key,
      content,
      updatedAt: record.updatedAt,
      displayName: h.displayNameFor(record.key),
      icon: h.iconFor(record.key),
    };
  }

  return {
    async loadBlocks(
      sessionId: string,
      existing?: readonly WorkingMemoryRecord[],
    ): Promise<readonly CoreMemoryBlock[]> {
      const h = helpersFor(await resolveSchema(sessionId));
      // `existing` lets the turn pipeline thread a single listWorkingMemory
      // read through loadWorkingMemory → initializeDefaults → loadBlocks
      // instead of three per turn (R-13). A pre-initializeDefaults list is
      // equivalent: missing labels synthesize the same empty block below.
      const all = existing ?? (await store.listWorkingMemory(sessionId));
      const blockMap = new Map<string, CoreMemoryBlock>();

      for (const record of all) {
        if (record.scope === SCOPE && h.labels.includes(record.key)) {
          blockMap.set(record.key, toBlock(record, h));
        }
      }

      // Return in canonical (schema) order, with empty blocks for missing labels
      return h.labels.map(
        (label) =>
          blockMap.get(label) ?? {
            label,
            content: "",
            updatedAt: new Date().toISOString(),
            displayName: h.displayNameFor(label),
            icon: h.iconFor(label),
          },
      );
    },

    async getBlock(
      sessionId: string,
      label: CoreMemoryLabel,
    ): Promise<CoreMemoryBlock | null> {
      const record = await store.getWorkingMemory(sessionId, SCOPE, label);
      if (!record) return null;
      const h = helpersFor(await resolveSchema(sessionId));
      return toBlock(record, h);
    },

    async updateBlock(
      sessionId: string,
      label: CoreMemoryLabel,
      content: string,
    ): Promise<void> {
      const h = helpersFor(await resolveSchema(sessionId));
      const maxChars = h.maxCharsFor(label);
      const truncated =
        content.length > maxChars ? content.slice(0, maxChars) : content;
      const now = new Date().toISOString();

      await store.upsertWorkingMemory({
        id: `memory:${sessionId}:${label}`,
        sessionId,
        key: label,
        scope: SCOPE,
        value: { text: truncated },
        updatedAt: now,
      });

      // Mirror to plugin-data so the memory UI panel (json-render) can
      // read it via dataSource.namespace = 'blocks'. This triggers
      // plugin-data.changed SSE events for real-time panel updates.
      // Only mirrors when a pluginId is configured (injected by bootstrap).
      if (mirrorPluginId) {
        await mirrorToPluginData(store, sessionId, mirrorPluginId, label, {
          content: truncated,
          displayName: h.displayNameFor(label),
          icon: h.iconFor(label),
          now,
        });
      }
    },

    async updateBlocks(
      sessionId: string,
      updates: ReadonlyMap<CoreMemoryLabel, string>,
    ): Promise<void> {
      const h = helpersFor(await resolveSchema(sessionId));
      const now = new Date().toISOString();

      const promises: Promise<void>[] = [];
      for (const [label, content] of updates) {
        const maxChars = h.maxCharsFor(label);
        const truncated =
          content.length > maxChars ? content.slice(0, maxChars) : content;
        promises.push(
          store.upsertWorkingMemory({
            id: `memory:${sessionId}:${label}`,
            sessionId,
            key: label,
            scope: SCOPE,
            value: { text: truncated },
            updatedAt: now,
          }),
        );
        if (mirrorPluginId) {
          promises.push(
            mirrorToPluginData(store, sessionId, mirrorPluginId, label, {
              content: truncated,
              displayName: h.displayNameFor(label),
              icon: h.iconFor(label),
              now,
            }),
          );
        }
      }
      await Promise.all(promises);
    },

    async initializeDefaults(
      sessionId: string,
      existing?: readonly WorkingMemoryRecord[],
    ): Promise<void> {
      const h = helpersFor(await resolveSchema(sessionId));
      const records = existing ?? (await store.listWorkingMemory(sessionId));
      const existingKeys = new Set(
        records.filter((r) => r.scope === SCOPE).map((r) => r.key),
      );

      const now = new Date().toISOString();
      const promises: Promise<void>[] = [];

      for (const label of h.labels) {
        if (!existingKeys.has(label)) {
          promises.push(
            store.upsertWorkingMemory({
              id: `memory:${sessionId}:${label}`,
              sessionId,
              key: label,
              scope: SCOPE,
              value: { text: "" },
              updatedAt: now,
            }),
          );
        }
      }

      if (promises.length > 0) await Promise.all(promises);
    },
  };
}

const PLUGIN_DATA_NS = "blocks";

/**
 * Mirror a core memory block to plugin-data so the json-render UI panel
 * can read it via `dataSource.namespace = 'blocks'`.
 *
 * This triggers `plugin-data.changed` SSE events when the store is
 * wrapped with the event proxy (see bootstrap.ts), enabling real-time
 * panel updates without polling.
 *
 * The pluginId and block display metadata are injected by the caller — the
 * memory package never hardcodes a specific plugin name or block vocabulary.
 */
async function mirrorToPluginData(
  store: DataStore,
  sessionId: string,
  pluginId: string,
  label: string,
  payload: {
    content: string;
    displayName: I18nText;
    icon: string;
    now: string;
  },
): Promise<void> {
  try {
    await store.setPluginData({
      id: `memory-pd:${sessionId}:${label}`,
      sessionId,
      pluginId,
      namespace: PLUGIN_DATA_NS,
      key: label,
      value: {
        content: payload.content,
        displayName: payload.displayName,
        icon: payload.icon,
        charCount: payload.content.length,
        updatedAt: payload.now,
      },
      createdAt: payload.now,
      updatedAt: payload.now,
    });
  } catch {
    // Non-fatal: UI panel won't update in real-time but core memory still works
  }
}
