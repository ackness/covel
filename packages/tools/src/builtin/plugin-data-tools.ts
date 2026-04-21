/**
 * Built-in plugin data tools — allow LLM agents to read/write plugin-scoped
 * persistent data via function calling.
 *
 * Read tools use the injected store directly. Write tools return
 * proposal-backed results so the Session Kernel commit chain performs the
 * actual persistence.
 */

import type { PluginDataBatchPayload, PluginDataPayload, Proposal } from '@covel/shared';
import { z } from 'zod';
import { withPendingProposals } from '../result.js';
import { tool } from '../tool.js';
import type { ToolModule } from '../types.js';

/** Minimal read-only store interface for plugin data operations. */
interface PluginDataStore {
  getPluginData(sessionId: string, pluginId: string, namespace: string, key: string): Promise<{
    namespace: string; key: string; value: unknown; updatedAt: string;
  } | null>;
  listPluginData(sessionId: string, pluginId: string, namespace?: string): Promise<Array<{
    namespace: string; key: string; value: unknown; updatedAt: string;
  }>>;
}

function makePluginDataProposal(
  context: { sessionId: string; turnId: string; pluginId: string; runtimeId: string },
  payload: PluginDataPayload,
  timestamp: string,
): Proposal {
  return {
    id: crypto.randomUUID(),
    type: 'plugin.data',
    source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
    turnId: context.turnId,
    sessionId: context.sessionId,
    payload: payload as unknown as Record<string, unknown>,
    timestamp,
  };
}

function makePluginDataBatchProposal(
  context: { sessionId: string; turnId: string; pluginId: string; runtimeId: string },
  payload: PluginDataBatchPayload,
  timestamp: string,
): Proposal {
  return {
    id: crypto.randomUUID(),
    type: 'plugin.data.batch',
    source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
    turnId: context.turnId,
    sessionId: context.sessionId,
    payload: payload as unknown as Record<string, unknown>,
    timestamp,
  };
}

// ── plugin-data-set ─────────────────────────────────────────────

function createPluginDataSetTool(): ToolModule {
  return tool({
    name: 'plugin-data-set',
    description: '将数据写入插件的持久化存储。数据按 namespace + key 组织，value 为任意 JSON。相同 (namespace, key) 会覆盖旧值。',
    parameters: z.object({
      namespace: z.string().min(1).describe('数据命名空间（如 "schema", "entries", "config"）'),
      key: z.string().min(1).describe('数据键名'),
      value: z.unknown().describe('要存储的 JSON 数据'),
    }),
    execute: async (params, context) => {
      const timestamp = new Date().toISOString();
      return withPendingProposals(
        {
          success: true,
          namespace: params.namespace,
          key: params.key,
        },
        [
          makePluginDataProposal(context, {
            namespace: params.namespace,
            key: params.key,
            value: params.value,
          }, timestamp),
        ],
      );
    },
  });
}

// ── plugin-data-set-batch ───────────────────────────────────────

function createPluginDataSetBatchTool(): ToolModule {
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
      const timestamp = new Date().toISOString();
      return withPendingProposals(
        {
          success: true,
          count: params.items.length,
          items: params.items.map((item) => ({ namespace: item.namespace, key: item.key })),
        },
        [
          makePluginDataBatchProposal(context, {
            items: params.items.map((item) => ({
              namespace: item.namespace,
              key: item.key,
              value: item.value,
            })),
          }, timestamp),
        ],
      );
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

/**
 * Create plugin data tools bound to a DataStore instance.
 * Call this during bootstrap when the store is available.
 *
 * Event emission is handled at the store level (via the decorated store proxy
 * in bootstrap.ts), so these tools no longer need an EventBus reference.
 */
export function createPluginDataTools(store: PluginDataStore): ToolModule[] {
  return [
    createPluginDataSetTool(),
    createPluginDataSetBatchTool(),
    createPluginDataGetTool(store),
    createPluginDataListTool(store),
  ];
}
