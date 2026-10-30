/**
 * Built-in plugin data tools — allow LLM agents to read/write plugin-scoped
 * persistent data via function calling.
 *
 * Read tools read through the host's scoped `context.store` when it is
 * present: it includes this execution's earlier writes (the caller's own and
 * those of completed upstream runtimes of the same plugin) and records what
 * the read saw, so the commit can drop a reader whose producer was dropped.
 * Without it they overlay the caller's pending proposals over the injected
 * store. Write tools return proposal-backed results so the Session Kernel
 * commit chain performs the actual persistence.
 */

import {
  pluginDataToolSizeError,
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
import { ToolError, tool, type JsonValue } from "@covel/plugin-handlers-utils";
import type { ToolExecutionContext, ToolModule } from "../types.js";

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

/** One row as the host's scoped store view returns it. */
interface ScopedPluginDataRow {
  readonly namespace?: string;
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt?: string;
}

/**
 * The host's scoped reads as they behave: rows carry their namespace and
 * timestamps, and a list without a namespace covers every namespace. The
 * public `PluginToolStore` type is narrower.
 */
interface ScopedPluginDataReads {
  getPluginData(
    namespace: string,
    key: string,
  ): Promise<ScopedPluginDataRow | null>;
  listPluginData(
    namespace: string | undefined,
  ): Promise<readonly ScopedPluginDataRow[]>;
}

function scopedReads(
  context: ToolExecutionContext,
): ScopedPluginDataReads | undefined {
  return context.store as ScopedPluginDataReads | undefined;
}

/** Model-driven writes never reach framework or hidden namespaces. */
function assertModelWritableNamespace(namespace: string): void {
  const reserved = reservedPluginDataNamespaceError(namespace);
  if (reserved) throw new ToolError("invalid-input", reserved);
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

/**
 * The commit boundary refuses an oversized value, but by then the model has
 * been told the write succeeded and the runtime's other writes go with it.
 * Refused here, the model reads the sizes and can write less.
 */
function assertValueFits(namespace: string, key: string, value: unknown): void {
  const tooLarge = pluginDataToolSizeError(namespace, key, value);
  if (tooLarge) throw new ToolError("invalid-input", tooLarge);
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
      assertValueFits(params.namespace, params.key, params.value);
      const timestamp = new Date().toISOString();
      return withPendingProposals(
        {
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
      for (const item of params.items) {
        assertModelWritableNamespace(item.namespace);
        assertValueFits(item.namespace, item.key, item.value);
      }
      const timestamp = new Date().toISOString();
      return withPendingProposals(
        {
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
    annotations: { readOnly: true, concurrencySafe: true, idempotent: true },
    description: "Read one entry from this plugin's persistent store.",
    parameters: z.object({
      namespace: z.string().min(1).describe("Data namespace"),
      key: z.string().min(1).describe("Data key"),
    }),
    execute: async (params, context) => {
      if (!isModelReadableNamespace(params.namespace))
        return { found: false, namespace: params.namespace, key: params.key };
      const scoped = scopedReads(context);
      if (scoped) {
        const row = await scoped.getPluginData(params.namespace, params.key);
        if (!row)
          return { found: false, namespace: params.namespace, key: params.key };
        return {
          found: true,
          namespace: params.namespace,
          key: params.key,
          value: row.value,
          ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
        };
      }
      const targetPlugin = context.pluginId;
      const record = await store.getPluginData(
        context.sessionId,
        targetPlugin,
        params.namespace,
        params.key,
      );
      // Buffered writes of this execution, including operation lists applied
      // on top of the stored value.
      const pending = overlayPluginDataValue(
        (context.pendingProposals ?? []).filter(
          (p) => p.sessionId === context.sessionId,
        ),
        targetPlugin,
        params.namespace,
        params.key,
        record
          ? { exists: true, value: record.value as JsonValue }
          : { exists: false },
      );
      if (!pending.exists) {
        return { found: false, namespace: params.namespace, key: params.key };
      }
      return {
        found: true,
        namespace: params.namespace,
        key: params.key,
        value: pending.value,
        ...(record ? { updatedAt: record.updatedAt } : {}),
      };
    },
  });
}

// ── plugin-data-list ────────────────────────────────────────────

function createPluginDataListTool(store: PluginDataStore): ToolModule {
  return tool({
    name: "plugin-data-list",
    annotations: { readOnly: true, concurrencySafe: true, idempotent: true },
    description:
      "List every entry of one namespace in this plugin's persistent store.",
    parameters: z.object({
      namespace: z
        .string()
        .optional()
        .describe("Data namespace; omit to list every namespace"),
    }),
    execute: async (params, context) => {
      if (params.namespace && !isModelReadableNamespace(params.namespace))
        return { count: 0, items: [] };
      const scoped = scopedReads(context);
      if (scoped) {
        const items = (await scoped.listPluginData(params.namespace)).flatMap(
          (row) => {
            const namespace = row.namespace ?? params.namespace;
            // A row whose namespace is unknown cannot be screened.
            if (namespace === undefined || !isModelReadableNamespace(namespace))
              return [];
            return [
              {
                namespace,
                key: row.key,
                value: row.value,
                ...(row.updatedAt !== undefined
                  ? { updatedAt: row.updatedAt }
                  : {}),
              },
            ];
          },
        );
        return { count: items.length, items };
      }
      const targetPlugin = context.pluginId;
      const records = (
        await store.listPluginData(
          context.sessionId,
          targetPlugin,
          params.namespace,
        )
      ).filter((record) => isModelReadableNamespace(record.namespace));

      const merged = new Map<
        string,
        { namespace: string; key: string; value: unknown; updatedAt?: string }
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
        records,
      )) {
        // The plugin's own code may buffer writes to its hidden buckets.
        if (!isModelReadableNamespace(namespace)) continue;
        if (deleted) merged.delete(overlayKey);
        else {
          const updatedAt = merged.get(overlayKey)?.updatedAt;
          merged.set(overlayKey, {
            namespace,
            key,
            value,
            ...(updatedAt !== undefined ? { updatedAt } : {}),
          });
        }
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
