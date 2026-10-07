/**
 * Built-in plugin data tools — allow LLM agents to read/write plugin-scoped
 * persistent data via function calling.
 *
 * Read tools overlay this execution's set, batch and delete proposals over
 * the injected store. Write tools return
 * proposal-backed results so the Session Kernel commit chain performs the
 * actual persistence.
 */

import {
  reservedPluginDataNamespaceError,
  type PluginDataBatchPayload,
  type PluginDataPayload,
  type Proposal,
} from "@covel/shared";
import { z } from "zod";
import { withPendingProposals } from "../result.js";
import {
  overlayPluginDataRows,
  overlayPluginDataValue,
} from "../proposal-overlay.js";
import { tool } from "../tool.js";
import type { ToolModule } from "../types.js";

/** Minimal read-only store interface for plugin data operations. */
interface PluginDataStore {
  getPluginData(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<{
    namespace: string;
    key: string;
    value: unknown;
    updatedAt: string;
  } | null>;
  listPluginData(
    sessionId: string,
    pluginId: string,
    namespace?: string,
  ): Promise<
    Array<{
      namespace: string;
      key: string;
      value: unknown;
      updatedAt: string;
    }>
  >;
}

function makePluginDataProposal(
  context: {
    sessionId: string;
    turnId: string;
    pluginId: string;
    runtimeId: string;
  },
  payload: PluginDataPayload,
  timestamp: string,
): Proposal {
  return {
    id: crypto.randomUUID(),
    type: "plugin.data",
    source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
    turnId: context.turnId,
    sessionId: context.sessionId,
    payload,
    timestamp,
  };
}

function makePluginDataBatchProposal(
  context: {
    sessionId: string;
    turnId: string;
    pluginId: string;
    runtimeId: string;
  },
  payload: PluginDataBatchPayload,
  timestamp: string,
): Proposal {
  return {
    id: crypto.randomUUID(),
    type: "plugin.data.batch",
    source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
    turnId: context.turnId,
    sessionId: context.sessionId,
    payload,
    timestamp,
  };
}

/** Model-driven writes never reach framework or hidden namespaces. */
function assertModelWritableNamespace(namespace: string): void {
  const reserved = reservedPluginDataNamespaceError(namespace);
  if (reserved) throw new Error(reserved);
}

/**
 * Whether a read tool may return rows of `namespace`. Tool results enter the
 * model's context, so reads stop where writes do: every `_` namespace holds
 * framework bookkeeping (job rows, logs, settlement receipts) or hidden world
 * data, never what a plugin stored for its agent.
 */
function isModelReadableNamespace(namespace: string): boolean {
  return reservedPluginDataNamespaceError(namespace) === null;
}

// ── plugin-data-set ─────────────────────────────────────────────

function createPluginDataSetTool(): ToolModule {
  return tool({
    name: "plugin-data-set",
    description:
      "Write data to this plugin's persistent store. Data is organized by namespace and key; value is any JSON. The same (namespace, key) replaces the old value.",
    parameters: z.object({
      namespace: z
        .string()
        .min(1)
        .describe('Data namespace, for example "schema", "entries", "config"'),
      key: z.string().min(1).describe("Data key"),
      value: z.unknown().describe("JSON data to store"),
    }),
    execute: async (params, context) => {
      assertModelWritableNamespace(params.namespace);
      const timestamp = new Date().toISOString();
      return withPendingProposals(
        {
          success: true,
          namespace: params.namespace,
          key: params.key,
        },
        [
          makePluginDataProposal(
            context,
            {
              namespace: params.namespace,
              key: params.key,
              value: params.value,
            },
            timestamp,
          ),
        ],
      );
    },
  });
}

// ── plugin-data-set-batch ───────────────────────────────────────

function createPluginDataSetBatchTool(): ToolModule {
  return tool({
    name: "plugin-data-set-batch",
    description:
      "Write several entries to this plugin's persistent store in one call, instead of one call per entry. The same (namespace, key) replaces the old value.",
    parameters: z.object({
      items: z
        .array(
          z.object({
            namespace: z.string().min(1).describe("Data namespace"),
            key: z.string().min(1).describe("Data key"),
            value: z.unknown().describe("JSON data to store"),
          }),
        )
        .min(1)
        .describe("Entries to write"),
    }),
    execute: async (params, context) => {
      for (const item of params.items)
        assertModelWritableNamespace(item.namespace);
      const timestamp = new Date().toISOString();
      return withPendingProposals(
        {
          success: true,
          count: params.items.length,
          items: params.items.map((item) => ({
            namespace: item.namespace,
            key: item.key,
          })),
        },
        [
          makePluginDataBatchProposal(
            context,
            {
              items: params.items.map((item) => ({
                namespace: item.namespace,
                key: item.key,
                value: item.value,
              })),
            },
            timestamp,
          ),
        ],
      );
    },
  });
}

// ── plugin-data-get ─────────────────────────────────────────────

function createPluginDataGetTool(store: PluginDataStore): ToolModule {
  return tool({
    name: "plugin-data-get",
    description: "Read one entry from this plugin's persistent store.",
    parameters: z.object({
      namespace: z.string().min(1).describe("Data namespace"),
      key: z.string().min(1).describe("Data key"),
    }),
    execute: async (params, context) => {
      if (!isModelReadableNamespace(params.namespace))
        return { found: false, namespace: params.namespace, key: params.key };
      const targetPlugin = context.pluginId;
      const pending = overlayPluginDataValue(
        (context.pendingProposals ?? []).filter(
          (p) => p.sessionId === context.sessionId,
        ),
        targetPlugin,
        params.namespace,
        params.key,
      );
      if (pending.hit) {
        if (pending.deleted) {
          return { found: false, namespace: params.namespace, key: params.key };
        }
        return {
          found: true,
          namespace: params.namespace,
          key: params.key,
          value: pending.value,
          updatedAt: new Date().toISOString(),
        };
      }
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
    name: "plugin-data-list",
    description:
      "List every entry of one namespace in this plugin's persistent store.",
    parameters: z.object({
      namespace: z
        .string()
        .optional()
        .describe("Data namespace; omit to list every namespace"),
    }),
    execute: async (params, context) => {
      const targetPlugin = context.pluginId;
      if (params.namespace && !isModelReadableNamespace(params.namespace))
        return { count: 0, items: [] };
      const records = (
        await store.listPluginData(
          context.sessionId,
          targetPlugin,
          params.namespace,
        )
      ).filter((record) => isModelReadableNamespace(record.namespace));

      const now = new Date().toISOString();
      const merged = new Map<
        string,
        { namespace: string; key: string; value: unknown; updatedAt: string }
      >();
      for (const r of records) {
        merged.set(JSON.stringify([r.namespace, r.key]), {
          namespace: r.namespace,
          key: r.key,
          value: r.value,
          updatedAt: r.updatedAt,
        });
      }
      for (const [
        overlayKey,
        { namespace, key, value, deleted },
      ] of overlayPluginDataRows(
        (context.pendingProposals ?? []).filter(
          (p) => p.sessionId === context.sessionId,
        ),
        targetPlugin,
        params.namespace,
      )) {
        // The plugin's own code may buffer writes to its hidden buckets.
        if (!isModelReadableNamespace(namespace)) continue;
        if (deleted) merged.delete(overlayKey);
        else merged.set(overlayKey, { namespace, key, value, updatedAt: now });
      }

      const items = [...merged.values()];
      return { count: items.length, items };
    },
  });
}

// ── Factory ─────────────────────────────────────────────────────

/**
 * Create plugin data tools bound to a DataStore instance.
 * Call this during bootstrap when the store is available.
 *
 * Writes and their committed events are owned by the Session Kernel commit
 * chain; these tools never persist proposals or emit committed state events.
 */
export function createPluginDataTools(store: PluginDataStore): ToolModule[] {
  return [
    createPluginDataSetTool(),
    createPluginDataSetBatchTool(),
    createPluginDataGetTool(store),
    createPluginDataListTool(store),
  ];
}
