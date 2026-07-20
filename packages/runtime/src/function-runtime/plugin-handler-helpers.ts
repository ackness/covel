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
} from "@covel/plugin-loader";
import type { RpcHandlerStore } from "@covel/shared";

export interface HandlerHelperContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
}

/**
 * Wrap a capability object so every method call first checks a revocation
 * flag (2026-07-20 audit H-09). A function-runtime handler that loses the
 * deadline race keeps running detached — without revocation its
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
 * Build a scoped plugin-data writer. Writes bypass the proposal system
 * and land directly on the store — intended for pre-commit placeholders
 * (e.g. "pending" frames) and post-commit patches that should not be
 * rolled back if the turn aborts.
 */
export function createPluginDataWriter(
  store: DataStore,
  ctx: HandlerHelperContext,
): PluginDataWriter {
  const { sessionId, pluginId } = ctx;
  return {
    async set(namespace: string, key: string, value: unknown) {
      if (value === null) {
        await store.deletePluginData(sessionId, pluginId, namespace, key);
        return;
      }
      const now = new Date().toISOString();
      await store.setPluginData({
        id: `${sessionId}:${pluginId}:${namespace}:${key}`,
        sessionId,
        pluginId,
        namespace,
        key,
        value,
        createdAt: now,
        updatedAt: now,
      });
    },
    async get(namespace: string, key: string) {
      const row = await store.getPluginData(
        sessionId,
        pluginId,
        namespace,
        key,
      );
      return row ? row.value : null;
    },
    async list(namespace: string) {
      const rows = await store.listPluginData(sessionId, pluginId, namespace);
      return rows.map((r) => ({ key: r.key, value: r.value }));
    },
    async delete(namespace: string, key: string) {
      await store.deletePluginData(sessionId, pluginId, namespace, key);
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
 * handlers (audit P0-3). Only the four documented read methods are
 * exposed — handlers that try to call `setPluginData`, `upsertCharacter`,
 * etc. will get `undefined` and a runtime TypeError, surfacing the
 * misuse loudly instead of letting third-party code silently bypass
 * proposal/tool governance.
 *
 * Builtin / official plugins keep the full DataStore because their guard /
 * handler logic implements framework primitives
 * (e.g. `world-init`'s historical-session reuse, `char-creator`'s
 * deterministic player upsert). The runtime decides which to inject.
 */
export function createFunctionStoreView(
  store: DataStore,
  ctx: HandlerHelperContext,
): FunctionStoreView {
  return {
    getPluginData(namespace, key) {
      return store.getPluginData(ctx.sessionId, ctx.pluginId, namespace, key);
    },
    listPluginData(namespace) {
      return store.listPluginData(ctx.sessionId, ctx.pluginId, namespace);
    },
    getSession() {
      return store.getSession(ctx.sessionId);
    },
    listTurnMessages(limit) {
      // A bounded read from inside a runtime handler means "recent context":
      // plugins asking for `limit` turn messages want the MOST RECENT ones.
      // `listTurnMessages(sessionId, { limit })` would return the OLDEST N, so
      // route a numeric limit through the tail query. No limit → full history.
      return typeof limit === "number"
        ? store.listRecentTurnMessages(ctx.sessionId, limit)
        : store.listTurnMessages(ctx.sessionId);
    },
  };
}

/**
 * Build a scoped store for community action-level RPC handlers. The method
 * shapes stay compatible with `RpcHandlerStore`, while session/plugin
 * arguments are bound to the current request so handler code cannot reach a
 * different session or plugin namespace by supplying alternate ids.
 */
export function createRpcHandlerStoreView(
  store: DataStore,
  ctx: Pick<HandlerHelperContext, "sessionId" | "pluginId">,
): RpcHandlerStore {
  return {
    getSession() {
      return store.getSession(ctx.sessionId);
    },
    listTurnMessages(_sessionId: string) {
      return store.listTurnMessages(ctx.sessionId);
    },
    savePlayerInput(input) {
      return store.savePlayerInput({
        ...input,
        sessionId: ctx.sessionId,
      });
    },
    async setPluginData(record) {
      const now = new Date().toISOString();
      await store.setPluginData({
        id: `${ctx.sessionId}:${ctx.pluginId}:${record.namespace}:${record.key}`,
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: record.namespace,
        key: record.key,
        value: record.value,
        createdAt: record.createdAt ?? now,
        updatedAt: record.updatedAt ?? now,
      });
    },
    getPluginData(_sessionId, _pluginId, namespace, key) {
      return store.getPluginData(ctx.sessionId, ctx.pluginId, namespace, key);
    },
    async listPluginData(_sessionId, _pluginId, namespace) {
      return store.listPluginData(ctx.sessionId, ctx.pluginId, namespace);
    },
  };
}
