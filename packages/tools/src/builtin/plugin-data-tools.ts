/**
 * Built-in plugin data tools — allow LLM agents to read/write plugin-scoped
 * persistent data via function calling.
 *
 * These tools require a DataStore instance, injected at creation time via
 * `createPluginDataTools(store)`. The store is captured in closures.
 */

import { z } from 'zod';
import { tool } from '../tool.js';
import type { ToolModule } from '../types.js';

/** Minimal store interface for plugin data operations (avoids @covel/store dependency). */
interface PluginDataStore {
  setPluginData(record: {
    id: string; sessionId: string; pluginId: string;
    namespace: string; key: string; value: unknown;
    createdAt: string; updatedAt: string;
  }): Promise<void>;
  setPluginDataBatch(records: readonly {
    id: string; sessionId: string; pluginId: string;
    namespace: string; key: string; value: unknown;
    createdAt: string; updatedAt: string;
  }[]): Promise<void>;
  getPluginData(sessionId: string, pluginId: string, namespace: string, key: string): Promise<{
    namespace: string; key: string; value: unknown; updatedAt: string;
  } | null>;
  listPluginData(sessionId: string, pluginId: string, namespace?: string): Promise<Array<{
    namespace: string; key: string; value: unknown; updatedAt: string;
  }>>;
}

/** Minimal event emitter interface (avoids @covel/events dependency). */
interface PluginDataEventEmitter {
  emit(message: {
    id: string; type: string; topic: string;
    payload: Record<string, unknown>;
    sessionId: string; turnId?: string; timestamp: string;
  }): void;
}

// ── plugin-data-set ─────────────────────────────────────────────

function createPluginDataSetTool(store: PluginDataStore, eventEmitter?: PluginDataEventEmitter): ToolModule {
  return tool({
    name: 'plugin-data-set',
    description: '将数据写入插件的持久化存储。数据按 namespace + key 组织，value 为任意 JSON。相同 (namespace, key) 会覆盖旧值。',
    parameters: z.object({
      namespace: z.string().min(1).describe('数据命名空间（如 "schema", "entries", "config"）'),
      key: z.string().min(1).describe('数据键名'),
      value: z.unknown().describe('要存储的 JSON 数据'),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      await store.setPluginData({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        pluginId: context.pluginId,
        namespace: params.namespace,
        key: params.key,
        value: params.value,
        createdAt: now,
        updatedAt: now,
      });
      emitPluginDataChanged(eventEmitter, context, [{
        namespace: params.namespace,
        key: params.key,
        value: params.value,
        operation: 'set' as const,
      }]);
      return {
        success: true,
        namespace: params.namespace,
        key: params.key,
      };
    },
  });
}

// ── plugin-data-set-batch ───────────────────────────────────────

function createPluginDataSetBatchTool(store: PluginDataStore, eventEmitter?: PluginDataEventEmitter): ToolModule {
  return tool({
    name: 'plugin-data-set-batch',
    description: '批量写入多条数据到插件持久化存储。一次调用写入整个数组，避免逐条调用的开销。相同 (namespace, key) 会覆盖旧值。',
    parameters: z.object({
      items: z.array(z.object({
        namespace: z.string().min(1).describe('数据命名空间'),
        key: z.string().min(1).describe('数据键名'),
        value: z.unknown().describe('要存储的 JSON 数据'),
      })).min(1).describe('要批量写入的数据条目数组'),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();
      const records = params.items.map((item) => ({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        pluginId: context.pluginId,
        namespace: item.namespace,
        key: item.key,
        value: item.value,
        createdAt: now,
        updatedAt: now,
      }));
      await store.setPluginDataBatch(records);
      emitPluginDataChanged(eventEmitter, context, params.items.map((item) => ({
        namespace: item.namespace,
        key: item.key,
        value: item.value,
        operation: 'set' as const,
      })));
      return {
        success: true,
        count: records.length,
        items: params.items.map((item) => ({ namespace: item.namespace, key: item.key })),
      };
    },
  });
}

// ── plugin-data-get ─────────────────────────────────────────────

function createPluginDataGetTool(store: PluginDataStore): ToolModule {
  return tool({
    name: 'plugin-data-get',
    description: '从当前插件的持久化存储中读取单条数据。',
    parameters: z.object({
      namespace: z.string().min(1).describe('数据命名空间'),
      key: z.string().min(1).describe('数据键名'),
    }),
    execute: async (params, context) => {
      const targetPlugin = context.pluginId;
      const record = await store.getPluginData(
        context.sessionId,
        targetPlugin,
        params.namespace,
        params.key,
      );
      if (!record) {
        return { found: false, namespace: params.namespace, key: params.key };
      }
      return {
        found: true,
        namespace: record.namespace,
        key: record.key,
        value: record.value,
        updatedAt: record.updatedAt,
      };
    },
  });
}

// ── plugin-data-list ────────────────────────────────────────────

function createPluginDataListTool(store: PluginDataStore): ToolModule {
  return tool({
    name: 'plugin-data-list',
    description: '列出当前插件持久化存储中某个 namespace 下的所有数据条目。',
    parameters: z.object({
      namespace: z.string().optional().describe('数据命名空间（不传则列出所有 namespace）'),
    }),
    execute: async (params, context) => {
      const targetPlugin = context.pluginId;
      const records = await store.listPluginData(
        context.sessionId,
        targetPlugin,
        params.namespace,
      );
      return {
        count: records.length,
        items: records.map((r) => ({
          namespace: r.namespace,
          key: r.key,
          value: r.value,
          updatedAt: r.updatedAt,
        })),
      };
    },
  });
}

// ── Factory ─────────────────────────────────────────────────────

// ── Event emission helper ───────────────────────────────────────

interface PluginDataChange {
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
  readonly operation: 'set' | 'delete';
}

function emitPluginDataChanged(
  eventEmitter: PluginDataEventEmitter | undefined,
  context: { sessionId: string; turnId: string; pluginId: string; runtimeId: string },
  changes: readonly PluginDataChange[],
): void {
  if (!eventEmitter || changes.length === 0) return;
  eventEmitter.emit({
    id: crypto.randomUUID(),
    type: 'event',
    topic: 'plugin',
    payload: {
      _subType: 'plugin-data.changed',
      pluginId: context.pluginId,
      runtimeId: context.runtimeId,
      changes,
    },
    sessionId: context.sessionId,
    turnId: context.turnId,
    timestamp: new Date().toISOString(),
  });
}

// ── Factory ─────────────────────────────────────────────────────

/**
 * Create plugin data tools bound to a DataStore instance.
 * Call this during bootstrap when the store is available.
 *
 * @param eventEmitter — optional EventBus; when provided, set/set-batch/delete
 *   tools emit `plugin-data.changed` events so the frontend can react in real-time.
 */
export function createPluginDataTools(store: PluginDataStore, eventEmitter?: PluginDataEventEmitter): ToolModule[] {
  return [
    createPluginDataSetTool(store, eventEmitter),
    createPluginDataSetBatchTool(store, eventEmitter),
    createPluginDataGetTool(store),
    createPluginDataListTool(store),
  ];
}
