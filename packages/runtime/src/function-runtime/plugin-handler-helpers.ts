/**
 * Factories for the per-call helpers we hand to function-runtime
 * handlers. Keeps the turn-executor and plugin-rpc call sites symmetrical
 * so manual-trigger runs and scheduled runs see the same ctx shape.
 *
 * Both helpers bind `sessionId` + `pluginId` + `runtimeId` so a handler
 * cannot use them to reach another plugin's data.
 */

import type { DataStore } from "@covel/store";
import type {
  PluginDataWriter,
  PluginLogger,
  FunctionStoreView,
} from "@covel/shared/plugin-runtime";
import {
  reservedPluginDataNamespaceError,
  type RpcHandlerStore,
} from "@covel/shared";
import { overlayPluginDataValue } from "@covel/tools";
import {
  bufferCharacterUpsert,
  bufferPluginData,
  bufferPluginDataBatch,
  bufferPluginDataDelete,
  mergeCharacterRecords,
  mergePluginDataRows,
  type ExecutionWriteBuffer,
} from "./execution-write-buffer.js";

export interface HandlerHelperContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
}

/**
 * Wrap a capability object so every method call first checks a revocation
 * flag. A function-runtime handler that loses the deadline race keeps running detached — without revocation its
 * store/media/gateway/pluginData capabilities remained live and could write
 * AFTER the session lock released, the snapshot completed, and the next turn
 * began. One shallow Proxy layer suffices: every framework capability handle
 * is a flat method object.
 */
export function makeRevocableCapability<T extends object>(
  target: T,
  isRevoked: () => boolean,
  label: string,
): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (isRevoked()) {
          throw new Error(
            `[function-runtime] capability "${label}.${String(prop)}" is revoked — ` +
              "the handler's deadline elapsed or its turn already completed",
          );
        }
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

/** Function-shaped variant of {@link makeRevocableCapability}. */
export function makeRevocableFn<A extends readonly unknown[], R>(
  fn: (...args: A) => R,
  isRevoked: () => boolean,
  label: string,
): (...args: A) => R {
  return (...args: A): R => {
    if (isRevoked()) {
      throw new Error(
        `[function-runtime] capability "${label}" is revoked — ` +
          "the handler's deadline elapsed or its turn already completed",
      );
    }
    return fn(...args);
  };
}

/**
 * Framework-owned (`_`-prefixed) namespaces are off-limits to plugin code —
 * these handles are the plugin-facing store surface, so they enforce the same
 * guard as the REST API and the commit boundary. Framework writers keep using
 * the raw store.
 */
function assertWritableNamespace(namespace: string): void {
  const reserved = reservedPluginDataNamespaceError(namespace);
  if (reserved) throw new Error(reserved);
}

/** Builtin runtime reads and proposal-backed writes; host control stays private. */
export type TrustedHandlerStore = Pick<
  DataStore,
  | "getSession"
  | "getWorld"
  | "listPlayerInputs"
  | "listTurnMessages"
  | "listRecentTurnMessages"
  | "getPluginData"
  | "listPluginData"
  | "listPluginDataSessionScope"
  | "listCharacters"
  | "setPluginData"
  | "setPluginDataBatch"
  | "deletePluginData"
  | "upsertCharacter"
>;

/**
 * Explicit execution capability: every write becomes a proposal. No raw-store
 * passthrough, transaction, session mutation, or disposal method is exposed.
 * Reads own their returned values, including with the live MemoryStore backend.
 */
export function createTrustedHandlerStore(
  store: DataStore,
  ctx: HandlerHelperContext,
  buffer: ExecutionWriteBuffer,
): TrustedHandlerStore {
  if (!ctx || !buffer) {
    throw new Error(
      "Runtime store requires an execution context and write buffer",
    );
  }
  const page = <T>(
    rows: T[],
    pagination?: { limit?: number; offset?: number },
  ): T[] => {
    const offset = pagination?.offset ?? 0;
    return rows.slice(
      offset,
      pagination?.limit === undefined ? undefined : offset + pagination.limit,
    );
  };
  return {
    getSession: async (...args) =>
      structuredClone(await store.getSession(...args)),
    getWorld: async (...args) => structuredClone(await store.getWorld(...args)),
    listPlayerInputs: async (...args) =>
      structuredClone(await store.listPlayerInputs(...args)),
    listTurnMessages: async (...args) =>
      structuredClone(await store.listTurnMessages(...args)),
    listRecentTurnMessages: async (...args) =>
      structuredClone(await store.listRecentTurnMessages(...args)),
    setPluginData(record) {
      assertWritableNamespace(record.namespace);
      bufferPluginData(buffer, ctx, record.namespace, record.key, record.value);
      return Promise.resolve();
    },
    setPluginDataBatch(records) {
      for (const record of records) assertWritableNamespace(record.namespace);
      bufferPluginDataBatch(buffer, ctx, records);
      return Promise.resolve();
    },
    upsertCharacter(record) {
      bufferCharacterUpsert(buffer, ctx, record);
      return Promise.resolve();
    },
    deletePluginData(_sessionId, _pluginId, namespace, key) {
      assertWritableNamespace(namespace);
      bufferPluginDataDelete(buffer, ctx, namespace, key);
      return Promise.resolve();
    },
    async getPluginData(sessionId, pluginId, namespace, key) {
      if (sessionId === ctx.sessionId) {
        const hit = overlayPluginDataValue(buffer, pluginId, namespace, key);
        if (hit.hit) {
          if (hit.deleted) return null;
          const now = new Date().toISOString();
          return {
            id: `${sessionId}:${pluginId}:${namespace}:${key}`,
            sessionId,
            pluginId,
            namespace,
            key,
            value: structuredClone(hit.value),
            createdAt: now,
            updatedAt: now,
          };
        }
      }
      return structuredClone(
        await store.getPluginData(sessionId, pluginId, namespace, key),
      );
    },
    async listPluginData(sessionId, pluginId, namespace, pagination) {
      if (sessionId !== ctx.sessionId || buffer.length === 0) {
        return structuredClone(
          await store.listPluginData(
            sessionId,
            pluginId,
            namespace,
            pagination,
          ),
        );
      }
      // Apply pagination after overlaying: a deleted row must not leave a hole,
      // and appended buffered rows must not exceed the requested page size.
      const stored = await store.listPluginData(sessionId, pluginId, namespace);
      return page(
        mergePluginDataRows(stored, buffer, sessionId, pluginId, namespace),
        pagination,
      );
    },
    async listPluginDataSessionScope(sessionId, pagination) {
      if (sessionId !== ctx.sessionId || buffer.length === 0) {
        return structuredClone(
          await store.listPluginDataSessionScope(sessionId, pagination),
        );
      }
      const stored = await store.listPluginDataSessionScope(sessionId);
      return page(mergePluginDataRows(stored, buffer, sessionId), pagination);
    },
    async listCharacters(sessionId) {
      const stored = await store.listCharacters(sessionId);
      return sessionId === ctx.sessionId
        ? mergeCharacterRecords(stored, buffer, sessionId)
        : structuredClone(stored);
    },
  };
}

/**
 * Build a scoped plugin-data writer.
 *
 * When `buffer` is supplied (the function-runtime execution path), `set`
 * routes through a `plugin.data` proposal so the write commits — and rolls
 * back — with the rest of the execution, and `get`/`list` overlay the buffer
 * so the handler reads its own not-yet-committed writes. Deletes (including
 * `set(null)`) use their own proposal and share the same transaction.
 *
 * Without a buffer the writer applies changes directly for the explicit
 * standalone test-runtime API, which has no execution commit pipeline.
 */
export function createPluginDataWriter(
  store: DataStore,
  ctx: HandlerHelperContext,
  buffer?: ExecutionWriteBuffer,
): PluginDataWriter {
  const { sessionId, pluginId } = ctx;
  return {
    async set(namespace: string, key: string, value: unknown) {
      assertWritableNamespace(namespace);
      if (value === null) {
        if (buffer) {
          bufferPluginDataDelete(buffer, ctx, namespace, key);
        } else {
          await store.deletePluginData(sessionId, pluginId, namespace, key);
        }
        return;
      }
      if (buffer) {
        bufferPluginData(buffer, ctx, namespace, key, value);
        return;
      }
      const now = new Date().toISOString();
      await store.setPluginData({
        id: `${sessionId}:${pluginId}:${namespace}:${key}`,
        sessionId,
        pluginId,
        namespace,
        key,
        value: structuredClone(value),
        createdAt: now,
        updatedAt: now,
      });
    },
    async get(namespace: string, key: string) {
      if (buffer) {
        const hit = overlayPluginDataValue(buffer, pluginId, namespace, key);
        if (hit.hit) return structuredClone(hit.value);
      }
      const row = await store.getPluginData(
        sessionId,
        pluginId,
        namespace,
        key,
      );
      return row ? structuredClone(row.value) : null;
    },
    async list(namespace: string) {
      const rows = await store.listPluginData(sessionId, pluginId, namespace);
      const merged = buffer
        ? mergePluginDataRows(rows, buffer, sessionId, pluginId, namespace)
        : rows;
      return structuredClone(
        merged.map((r) => ({ key: r.key, value: r.value })),
      );
    },
    async delete(namespace: string, key: string) {
      assertWritableNamespace(namespace);
      if (buffer) {
        bufferPluginDataDelete(buffer, ctx, namespace, key);
      } else {
        await store.deletePluginData(sessionId, pluginId, namespace, key);
      }
    },
  };
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LOGS_NAMESPACE = "_logs";
const MAX_LOG_ENTRIES = 200;

/**
 * Build a per-runtime logger that appends rows to the plugin's `_logs`
 * namespace. Keys are `<timestampMs>-<uuid>` so natural sort matches
 * chronological order. When the ring hits `MAX_LOG_ENTRIES`, the oldest
 * rows are evicted so a chatty plugin can't balloon the table.
 */
export function createPluginLogger(
  store: DataStore,
  ctx: HandlerHelperContext,
): PluginLogger {
  async function append(
    level: LogLevel,
    message: string,
    meta: Record<string, unknown> | undefined,
  ): Promise<void> {
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const key = `${nowMs.toString(36).padStart(9, "0")}-${crypto.randomUUID().slice(0, 8)}`;
    const entry = {
      level,
      message: typeof message === "string" ? message : String(message),
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
      turnId: ctx.turnId,
      runtimeId: ctx.runtimeId,
      timestamp: nowIso,
    };

    try {
      await store.setPluginData({
        id: `${ctx.sessionId}:${ctx.pluginId}:${LOGS_NAMESPACE}:${key}`,
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: LOGS_NAMESPACE,
        key,
        value: entry,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      // Evict oldest entries beyond MAX_LOG_ENTRIES. Done eagerly rather than
      // on a timer so a background plugin that never touches the store again
      // still rotates naturally on its last write.
      const rows = await store.listPluginData(
        ctx.sessionId,
        ctx.pluginId,
        LOGS_NAMESPACE,
      );
      if (rows.length > MAX_LOG_ENTRIES) {
        const sorted = [...rows].sort((a, b) => a.key.localeCompare(b.key));
        const excess = sorted.length - MAX_LOG_ENTRIES;
        for (let i = 0; i < excess; i += 1) {
          await store.deletePluginData(
            ctx.sessionId,
            ctx.pluginId,
            LOGS_NAMESPACE,
            sorted[i].key,
          );
        }
      }
    } catch {
      // Logging must never throw into plugin code — a store write failure
      // should not crash the runtime. The loss surfaces later via
      // observability on the store itself.
    }
  }

  return {
    async debug(message: string, meta?: Record<string, unknown>) {
      await append("debug", message, meta);
    },
    async info(message: string, meta?: Record<string, unknown>) {
      await append("info", message, meta);
    },
    async warn(message: string, meta?: Record<string, unknown>) {
      await append("warn", message, meta);
    },
    async error(message: string, meta?: Record<string, unknown>) {
      await append("error", message, meta);
    },
  };
}

/**
 * Build a narrow `FunctionStoreView` for community function-runtime
 * handlers. Only documented, session-scoped read methods are
 * exposed — handlers that try to call `setPluginData`, `upsertCharacter`,
 * etc. will get `undefined` and a runtime TypeError, surfacing the
 * misuse loudly instead of letting third-party code silently bypass
 * proposal/tool governance.
 *
 * Builtin handlers additionally receive explicit world/character reads and
 * proposal-backed writes through createTrustedHandlerStore.
 */
export function createFunctionStoreView(
  store: DataStore,
  ctx: HandlerHelperContext,
  buffer?: ExecutionWriteBuffer,
): FunctionStoreView {
  const reads = createTrustedHandlerStore(store, ctx, buffer ?? []);
  return {
    getPluginData(namespace, key) {
      return reads.getPluginData(ctx.sessionId, ctx.pluginId, namespace, key);
    },
    listPluginData(namespace) {
      return reads.listPluginData(ctx.sessionId, ctx.pluginId, namespace);
    },
    getSession() {
      return reads.getSession(ctx.sessionId);
    },
    listPlayerInputs() {
      return reads.listPlayerInputs(ctx.sessionId);
    },
    listTurnMessages(limit) {
      // A bounded read from inside a runtime handler means "recent context":
      // plugins asking for `limit` turn messages want the MOST RECENT ones.
      // `listTurnMessages(sessionId, { limit })` would return the OLDEST N, so
      // route a numeric limit through the tail query. No limit → full history.
      return typeof limit === "number"
        ? reads.listRecentTurnMessages(ctx.sessionId, limit)
        : reads.listTurnMessages(ctx.sessionId);
    },
  };
}

/**
 * Build a scoped immediate-write store for all plugin action-level RPC handlers.
 * Method shapes stay compatible with `RpcHandlerStore`, while session/plugin
 * arguments are bound to the current request so handler code cannot reach a
 * different session or plugin namespace by supplying alternate ids.
 */
export function createRpcHandlerStoreView(
  store: DataStore,
  ctx: Pick<HandlerHelperContext, "sessionId" | "pluginId">,
): RpcHandlerStore {
  return {
    async getSession() {
      return structuredClone(await store.getSession(ctx.sessionId));
    },
    async listTurnMessages(_sessionId: string) {
      return structuredClone(await store.listTurnMessages(ctx.sessionId));
    },
    savePlayerInput(input) {
      return store.savePlayerInput({
        ...structuredClone(input),
        sessionId: ctx.sessionId,
      });
    },
    async setPluginData(record) {
      assertWritableNamespace(record.namespace);
      const input = structuredClone(record);
      const existing = await store.getPluginData(
        ctx.sessionId,
        ctx.pluginId,
        input.namespace,
        input.key,
      );
      const now = new Date().toISOString();
      await store.setPluginData({
        // Preserve existing row identity without trusting a caller-supplied id.
        id:
          existing?.id ??
          `${ctx.sessionId}:${ctx.pluginId}:${input.namespace}:${input.key}`,
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: input.namespace,
        key: input.key,
        value: input.value,
        createdAt: existing?.createdAt ?? input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      });
    },
    async getPluginData(_sessionId, _pluginId, namespace, key) {
      return structuredClone(
        await store.getPluginData(ctx.sessionId, ctx.pluginId, namespace, key),
      );
    },
    async listPluginData(_sessionId, _pluginId, namespace) {
      return structuredClone(
        await store.listPluginData(ctx.sessionId, ctx.pluginId, namespace),
      );
    },
  };
}
