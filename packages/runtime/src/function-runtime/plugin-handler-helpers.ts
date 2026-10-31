import {
  datasetFailure,
  type DatasetPolicyResolver,
} from "../plugin-data-validation.js";
/**
 * Factories for the per-call helpers we hand to function-runtime
 * handlers. Keeps the turn-executor and plugin-rpc call sites symmetrical
 * so manual-trigger runs and scheduled runs see the same ctx shape.
 *
 * Both helpers bind `sessionId` + `pluginId` + `runtimeId` so a handler
 * cannot use them to reach another plugin's data.
 */

import { compareText } from "@covel/shared";
import type {
  DataStore,
  TurnMessageRecord,
  WriteOrderedTurnMessage,
} from "@covel/store";
import type {
  PluginDataWriter,
  PluginLogger,
  FunctionStoreView,
  PluginTurnMessage,
  PluginSessionView,
  PluginSetupRuntimeState,
} from "@covel/shared/plugin-runtime";
import type { Proposal, Session, SetupRuntimeState } from "@covel/shared";
import {
  applyDataOps,
  dataOpsSchema,
  isHiddenPluginDataNamespace,
  pluginCodeNamespaceWriteError,
  ToolError,
  pluginDataEntry,
  readEnvChoice,
  readEnvString,
  type DataOpsCurrent,
  type JsonValue,
  type RpcHandlerStore,
} from "@covel/shared";
import { overlayPluginDataValue } from "@covel/tools";
import { pluginDataSizeError } from "@covel/shared";
import {
  bufferPluginData,
  bufferPluginDataDelete,
  bufferPluginDataUpdate,
  mergePluginDataRows,
  type ExecutionWriteBuffer,
} from "./execution-write-buffer.js";
import {
  listPluginDataProducers,
  noteRead,
  observedRows,
  readPluginDataKey,
  type PluginDataVisibility,
} from "./upstream-plugin-data.js";

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
 * guard as the commit boundary. The plugin's own `_hidden.*` buckets are the
 * one exception. Framework writers keep using the raw store.
 */
function assertWritableNamespace(namespace: string): void {
  const reserved = pluginCodeNamespaceWriteError(namespace);
  if (reserved) throw new Error(reserved);
}

function assertPluginDataSize(
  pluginId: string,
  namespace: string,
  key: string,
  value: unknown,
): void {
  const error = pluginDataSizeError(pluginId, namespace, key, value);
  if (error) throw new Error(error);
}

const TURN_MESSAGE_PAGE_DEFAULT = 100;
const TURN_MESSAGE_PAGE_MAX = 500;

/**
 * The cursor is opaque to plugins; it is the save order (`writeSeq`) of the
 * last message read. A message saved later never has a lower one, so a stored
 * cursor misses nothing, even a background execution's older-timestamped text.
 */
function encodeTurnMessageCursor(message: WriteOrderedTurnMessage): string {
  return String(message.writeSeq);
}

function decodeTurnMessageCursor(cursor: string): number {
  const writeSeq = /^(0|[1-9]\d*)$/.test(cursor) ? Number(cursor) : NaN;
  if (!Number.isSafeInteger(writeSeq))
    throw new TypeError("Invalid turn message cursor");
  return writeSeq;
}

function toPluginTurnMessage(message: TurnMessageRecord): PluginTurnMessage {
  return {
    id: message.id,
    turnId: message.turnId,
    sourceType: message.sourceType,
    ...(message.sourcePluginId !== undefined
      ? { sourcePluginId: message.sourcePluginId }
      : {}),
    ...(message.sourceRuntimeId !== undefined
      ? { sourceRuntimeId: message.sourceRuntimeId }
      : {}),
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    compacted: message.compactedAtTurnId != null,
  };
}

/**
 * Keyset page over the committed timeline. Long-context plugins walk the whole
 * log in bounded reads instead of cloning every message on each execution.
 */
async function readTurnMessagePage(
  store: DataStore,
  sessionId: string,
  options: Parameters<FunctionStoreView["readTurnMessages"]>[0],
): ReturnType<FunctionStoreView["readTurnMessages"]> {
  const requested = options?.limit ?? TURN_MESSAGE_PAGE_DEFAULT;
  if (!Number.isSafeInteger(requested) || requested < 1)
    throw new RangeError("readTurnMessages limit must be a positive integer");
  const limit = Math.min(requested, TURN_MESSAGE_PAGE_MAX);
  const after =
    options?.after === undefined
      ? null
      : decodeTurnMessageCursor(options.after);
  const rows = await store.listTurnMessagesAfter(sessionId, after, limit);
  const last = rows.at(-1);
  return {
    messages: rows.map(toPluginTurnMessage),
    cursor: last ? encodeTurnMessageCursor(last) : (options?.after ?? null),
    hasMore: rows.length === limit,
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
 * `visibility` adds the writes of completed upstream runtimes of the same
 * plugin under the buffer, and records which of them each `get`/`list` saw.
 * They are never buffered: only this runtime's writes commit with it.
 *
 * `update` checks its operations against the current view (store row,
 * upstream writes, buffer) and buffers a `plugin.data.update` proposal, which
 * the commit applies to the latest stored value. The check records no
 * dependency: the commit applies the operations to what really landed.
 *
 * Without a buffer the writer applies changes directly for the explicit
 * standalone test-runtime API, which has no execution commit pipeline.
 */
export function createPluginDataWriter(
  store: DataStore,
  ctx: HandlerHelperContext,
  buffer?: ExecutionWriteBuffer,
  visibility?: PluginDataVisibility,
): PluginDataWriter {
  const { sessionId, pluginId } = ctx;
  /** One key's stored row with upstream and buffered writes applied. */
  const readKey = async (namespace: string, key: string) => {
    const row = await store.getPluginData(sessionId, pluginId, namespace, key);
    const base: DataOpsCurrent = row
      ? { exists: true, value: row.value as JsonValue }
      : { exists: false };
    // Read lazily: the buffer grows while the handler runs.
    return {
      base,
      ...readPluginDataKey(
        buffer ? visibility : undefined,
        buffer ?? [],
        pluginId,
        namespace,
        key,
        base,
      ),
    };
  };
  const currentView = async (
    namespace: string,
    key: string,
  ): Promise<DataOpsCurrent> => (await readKey(namespace, key)).current;
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
      assertPluginDataSize(pluginId, namespace, key, value);
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
      const { base, current, producers } = await readKey(namespace, key);
      const visible = current.exists ? current.value : null;
      if (buffer)
        noteRead(visibility, {
          kind: "get",
          namespace,
          key,
          visible,
          producers,
          withoutUpstream: () => {
            const own = overlayPluginDataValue(
              buffer,
              pluginId,
              namespace,
              key,
              base,
            );
            return own.exists ? own.value : null;
          },
        });
      if (!current.exists) return null;
      return buffer ? structuredClone(current.value) : current.value;
    },
    async list(namespace: string) {
      const rows = await store.listPluginData(sessionId, pluginId, namespace);
      if (!buffer) return rows.map(pluginDataEntry);
      const merged = mergePluginDataRows(
        rows,
        buffer,
        sessionId,
        pluginId,
        namespace,
        visibility?.writes,
      );
      noteRead(visibility, {
        kind: "list",
        namespace,
        visible: observedRows(merged),
        producers: listPluginDataProducers(visibility, namespace),
        withoutUpstream: () =>
          observedRows(
            mergePluginDataRows(rows, buffer, sessionId, pluginId, namespace),
          ),
      });
      return merged.map(pluginDataEntry);
    },
    async delete(namespace: string, key: string) {
      assertWritableNamespace(namespace);
      if (buffer) {
        bufferPluginDataDelete(buffer, ctx, namespace, key);
      } else {
        await store.deletePluginData(sessionId, pluginId, namespace, key);
      }
    },
    async update(namespace: string, key: string, ops: unknown) {
      assertWritableNamespace(namespace);
      const parsed = dataOpsSchema.safeParse(ops);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 3)
          .map((issue) =>
            issue.path.length > 0
              ? `${issue.path.join(".")}: ${issue.message}`
              : issue.message,
          )
          .join("; ");
        throw new TypeError(`pluginData.update: invalid ops (${issues})`);
      }
      const result = applyDataOps(
        await currentView(namespace, key),
        parsed.data,
      );
      if (!result.ok) {
        throw new Error(`pluginData.update: ${result.error.message}`);
      }
      if (result.exists) {
        assertPluginDataSize(pluginId, namespace, key, result.value);
      }
      if (buffer) {
        bufferPluginDataUpdate(
          buffer,
          ctx,
          namespace,
          key,
          structuredClone(parsed.data),
        );
        return;
      }
      if (!result.exists) {
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
        value: structuredClone(result.value),
        createdAt: now,
        updatedAt: now,
      });
    },
  };
}

/**
 * The writer a write service's handler gets for its provider's own data.
 *
 * Writes go to `buffer` (one call's writes, carrying the provider's
 * identity); the registry stages them as one operation when the call
 * succeeds. Reads overlay, in order: committed rows, upstream writes of the
 * provider in this execution (`visibility`, which records the producers a
 * read saw on the caller's recorder), the operations the caller already
 * staged for the provider (`staged`), and this call's buffer. The last two
 * record nothing.
 *
 * Errors are the model-facing kind a caller can act on: a write into any `_`
 * namespace, bad operations or an oversized value are `invalid-input`, and
 * an `update` that does not apply to the current view is `conflict`. Once
 * `signal` aborts (the call ended, timed out or was cancelled) every method
 * throws.
 */
export function createServicePluginDataWriter(args: {
  readonly store?: Pick<DataStore, "getPluginData" | "listPluginData">;
  readonly identity: HandlerHelperContext;
  readonly signal: AbortSignal;
  readonly visibility?: PluginDataVisibility;
  readonly staged: () => readonly Proposal[];
  readonly buffer: ExecutionWriteBuffer;
}): PluginDataWriter {
  const { store, identity, signal, visibility, buffer } = args;
  const { sessionId, pluginId } = identity;
  const live = () => signal.throwIfAborted();
  const overlay = () => [...args.staged(), ...buffer];
  const writable = (namespace: string) => {
    live();
    if (typeof namespace !== "string" || namespace.startsWith("_"))
      throw new ToolError(
        "invalid-input",
        `A write service cannot write the reserved namespace "${String(namespace)}".`,
      );
    const reserved = pluginCodeNamespaceWriteError(namespace);
    if (reserved) throw new ToolError("invalid-input", reserved);
  };
  const sized = (namespace: string, key: string, value: unknown) => {
    const error = pluginDataSizeError(pluginId, namespace, key, value);
    if (error) throw new ToolError("invalid-input", error);
  };
  const readKey = async (namespace: string, key: string) => {
    const row = await store?.getPluginData(sessionId, pluginId, namespace, key);
    live();
    const base: DataOpsCurrent = row
      ? { exists: true, value: row.value as JsonValue }
      : { exists: false };
    return {
      base,
      ...readPluginDataKey(
        visibility,
        overlay(),
        pluginId,
        namespace,
        key,
        base,
      ),
    };
  };
  return {
    async get(namespace: string, key: string) {
      live();
      if (isHiddenPluginDataNamespace(namespace)) return null;
      const { base, current, producers } = await readKey(namespace, key);
      const visible = current.exists ? current.value : null;
      noteRead(visibility, {
        kind: "get",
        namespace,
        key,
        visible,
        producers,
        withoutUpstream: () => {
          const own = overlayPluginDataValue(
            overlay(),
            pluginId,
            namespace,
            key,
            base,
          );
          return own.exists ? own.value : null;
        },
      });
      return structuredClone(visible);
    },
    async list(namespace: string) {
      live();
      if (isHiddenPluginDataNamespace(namespace)) return [];
      const rows =
        (await store?.listPluginData(sessionId, pluginId, namespace)) ?? [];
      live();
      const merged = mergePluginDataRows(
        rows,
        overlay(),
        sessionId,
        pluginId,
        namespace,
        visibility?.writes,
      );
      noteRead(visibility, {
        kind: "list",
        namespace,
        visible: observedRows(merged),
        producers: listPluginDataProducers(visibility, namespace),
        withoutUpstream: () =>
          observedRows(
            mergePluginDataRows(
              rows,
              overlay(),
              sessionId,
              pluginId,
              namespace,
            ),
          ),
      });
      return structuredClone(merged.map(pluginDataEntry));
    },
    async set(namespace: string, key: string, value: unknown) {
      writable(namespace);
      if (value === null) {
        bufferPluginDataDelete(buffer, identity, namespace, key);
        return;
      }
      sized(namespace, key, value);
      bufferPluginData(buffer, identity, namespace, key, value);
    },
    async delete(namespace: string, key: string) {
      writable(namespace);
      bufferPluginDataDelete(buffer, identity, namespace, key);
    },
    async update(namespace: string, key: string, ops: unknown) {
      writable(namespace);
      const parsed = dataOpsSchema.safeParse(ops);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 3)
          .map((issue) =>
            issue.path.length > 0
              ? `${issue.path.join(".")}: ${issue.message}`
              : issue.message,
          )
          .join("; ");
        throw new ToolError(
          "invalid-input",
          `pluginData.update: invalid ops (${issues})`,
        );
      }
      const { current } = await readKey(namespace, key);
      const result = applyDataOps(current, parsed.data);
      if (!result.ok)
        throw new ToolError(
          "conflict",
          `pluginData.update: ${result.error.message}`,
        );
      if (result.exists) sized(namespace, key, result.value);
      live();
      bufferPluginDataUpdate(
        buffer,
        identity,
        namespace,
        key,
        structuredClone(parsed.data),
      );
    },
  };
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/** `COVEL_PLUGIN_LOG_LEVEL`, else `info` in production and `debug` otherwise. */
function pluginLogThreshold(): number {
  const fallback: LogLevel =
    readEnvString("NODE_ENV") === "production" ? "info" : "debug";
  return LOG_LEVELS.indexOf(
    readEnvChoice("COVEL_PLUGIN_LOG_LEVEL", LOG_LEVELS, fallback),
  );
}

const LOGS_NAMESPACE = "_logs";
const MAX_LOG_ENTRIES = 200;
const LOG_EVICTION_INTERVAL = 20;
/** Longest `meta` a warning or error carries into the server log. */
const SERVER_LOG_META_CHARS = 2_000;

/**
 * A plugin's warning or error also goes to the server log. The `_logs` ring
 * belongs to one session and is read through the store; an operator who
 * looks for why a runtime failed reads the server log first.
 */
function mirrorToServerLog(
  level: "warn" | "error",
  runtimeId: string,
  message: string,
  meta: Record<string, unknown> | undefined,
): void {
  let detail = "";
  if (meta && Object.keys(meta).length > 0) {
    try {
      detail = ` ${JSON.stringify(meta).slice(0, SERVER_LOG_META_CHARS)}`;
    } catch {
      // A value that cannot be serialized is left out of the line.
    }
  }
  console[level](`[plugin-log] ${runtimeId}: ${message}${detail}`);
}

/**
 * Build a per-runtime logger that appends rows to the plugin's `_logs`
 * namespace. Keys are `<timestampMs>-<uuid>` so natural sort matches
 * chronological order. When the ring exceeds `MAX_LOG_ENTRIES`, the oldest
 * rows are evicted so a chatty plugin can't balloon the table. The ring is
 * checked on a logger's first write and every `LOG_EVICTION_INTERVAL` writes
 * after, so a log line costs one write instead of a full namespace read.
 * Warnings and errors are also written to the server log.
 */
export function createPluginLogger(
  store: DataStore,
  ctx: HandlerHelperContext,
): PluginLogger {
  let appended = 0;
  const threshold = pluginLogThreshold();
  async function append(
    level: LogLevel,
    message: string,
    meta: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    if (level === "warn" || level === "error")
      mirrorToServerLog(level, ctx.runtimeId, String(message), meta);
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
      // Evict oldest entries beyond MAX_LOG_ENTRIES. Done on write rather than
      // on a timer so a background plugin that never touches the store again
      // still rotates naturally.
      if (appended++ % LOG_EVICTION_INTERVAL !== 0) return;
      const rows = await store.listPluginData(
        ctx.sessionId,
        ctx.pluginId,
        LOGS_NAMESPACE,
      );
      if (rows.length > MAX_LOG_ENTRIES) {
        const sorted = [...rows].sort((a, b) => compareText(a.key, b.key));
        const excess = sorted.length - MAX_LOG_ENTRIES;
        for (const row of sorted.slice(0, excess)) {
          await store.deletePluginData(
            ctx.sessionId,
            ctx.pluginId,
            LOGS_NAMESPACE,
            row.key,
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
 * What plugin code reads of the session: the public `PluginSessionView`, a
 * projection of the record, never the record itself.
 */
function pluginSessionView(
  session: Pick<
    Session,
    "phase" | "completedPlayerTurns" | "locale" | "setupRuntimes"
  > | null,
): PluginSessionView {
  if (!session) throw new Error("The session no longer exists");
  return {
    phase: session.phase,
    completedPlayerTurns: session.completedPlayerTurns,
    locale: session.locale,
    setupRuntimes: Object.fromEntries(
      Object.entries(session.setupRuntimes).map(([runtimeId, state]) => [
        runtimeId,
        pluginSetupRuntimeState(state),
      ]),
    ),
  };
}

function pluginSetupRuntimeState(
  state: SetupRuntimeState,
): PluginSetupRuntimeState {
  switch (state.state) {
    case "pending":
      return {
        state: "pending",
        ...(state.lastError !== undefined
          ? { lastError: state.lastError }
          : {}),
      };
    case "done":
      return {
        state: "done",
        resolution: state.resolution,
        ...(state.warning !== undefined ? { warning: state.warning } : {}),
      };
    case "blocked":
      return {
        state: "blocked",
        reason: state.reason,
        ...(state.lastError !== undefined
          ? { lastError: state.lastError }
          : {}),
      };
  }
}

/**
 * Build the narrow `FunctionStoreView` every function handler and agent
 * guard receives, bundled or installed. Only documented, session-scoped read
 * methods are exposed — handlers that try to call `setPluginData`,
 * `upsertCharacter`, etc. will get `undefined` and a runtime TypeError,
 * surfacing the misuse loudly instead of letting plugin code silently bypass
 * proposal/tool governance. World reads go through `ctx.world`, writes
 * through `ctx.pluginData` and returned proposals.
 */
export function createFunctionStoreView(
  store: DataStore | undefined,
  ctx: HandlerHelperContext,
  buffer?: readonly Proposal[],
  visibility?: PluginDataVisibility,
): FunctionStoreView {
  if (!store) {
    const unavailable = async (): Promise<never> => {
      throw new Error(
        "Function store is unavailable: configure execution deps.store",
      );
    };
    return {
      getPluginData: unavailable,
      listPluginData: unavailable,
      getSession: unavailable,
      listPlayerInputs: unavailable,
      listTurnMessages: unavailable,
      readTurnMessages: unavailable,
    };
  }
  const { sessionId, pluginId } = ctx;
  const overlay = buffer ?? [];
  return {
    getSession: async () =>
      pluginSessionView(await store.getSession(sessionId)),
    listPlayerInputs: () => store.listPlayerInputs(sessionId),
    // A bounded read from inside a runtime handler means "recent context":
    // plugins asking for `limit` turn messages want the MOST RECENT ones.
    // `listTurnMessages(sessionId, { limit })` would return the OLDEST N, so
    // route a numeric limit through the tail query. No limit → full history.
    listTurnMessages: (limit) =>
      typeof limit === "number"
        ? store.listRecentTurnMessages(sessionId, limit)
        : store.listTurnMessages(sessionId),
    readTurnMessages: (options) =>
      readTurnMessagePage(store, sessionId, options),
    async getPluginData(namespace, key) {
      const row = await store.getPluginData(
        sessionId,
        pluginId,
        namespace,
        key,
      );
      const base: DataOpsCurrent = row
        ? { exists: true, value: row.value as JsonValue }
        : { exists: false };
      // Read lazily: the buffer grows while the handler runs.
      const { hit, current, producers } = readPluginDataKey(
        visibility,
        overlay,
        pluginId,
        namespace,
        key,
        base,
      );
      noteRead(visibility, {
        kind: "get",
        namespace,
        key,
        visible: current.exists ? current.value : null,
        producers,
        withoutUpstream: () => {
          const own = overlayPluginDataValue(
            overlay,
            pluginId,
            namespace,
            key,
            base,
          );
          return own.exists ? own.value : null;
        },
      });
      if (!hit) return row;
      if (!current.exists) return null;
      return {
        id: row?.id ?? `${sessionId}:${pluginId}:${namespace}:${key}`,
        sessionId,
        pluginId,
        namespace,
        key,
        value: structuredClone(current.value),
        ...(row ? { createdAt: row.createdAt, updatedAt: row.updatedAt } : {}),
      };
    },
    // The public type takes a namespace; without one the view lists every
    // namespace, as the store does.
    async listPluginData(namespace: string | undefined) {
      const stored = await store.listPluginData(sessionId, pluginId, namespace);
      const merged = mergePluginDataRows(
        stored,
        overlay,
        sessionId,
        pluginId,
        namespace,
        visibility?.writes,
      );
      noteRead(visibility, {
        kind: "list",
        ...(namespace !== undefined ? { namespace } : {}),
        visible: observedRows(merged),
        producers: listPluginDataProducers(visibility, namespace),
        withoutUpstream: () =>
          observedRows(
            mergePluginDataRows(
              stored,
              overlay,
              sessionId,
              pluginId,
              namespace,
            ),
          ),
      });
      return merged;
    },
  };
}

/** Ceiling (and default) of `listTurnMessages` in a plugin action's store view. */
const RPC_TURN_MESSAGE_LIMIT = 200;

/**
 * Build a scoped immediate-write store for all plugin action-level RPC handlers.
 * Method shapes match `RpcHandlerStore`, while session/plugin
 * arguments are bound to the current request so handler code cannot reach a
 * different session or plugin namespace by supplying alternate ids.
 */
export function createRpcHandlerStoreView(
  store: DataStore,
  ctx: Pick<HandlerHelperContext, "sessionId" | "pluginId">,
  options: { readonly datasetPolicy?: DatasetPolicyResolver } = {},
): RpcHandlerStore {
  return {
    async getSession() {
      return pluginSessionView(await store.getSession(ctx.sessionId));
    },
    async listTurnMessages(limit) {
      // An action wants recent context, never the whole history.
      const wanted =
        limit !== undefined && Number.isFinite(limit)
          ? Math.trunc(limit)
          : RPC_TURN_MESSAGE_LIMIT;
      const count = Math.min(Math.max(wanted, 0), RPC_TURN_MESSAGE_LIMIT);
      return store.listRecentTurnMessages(ctx.sessionId, count);
    },
    async setPluginData(record) {
      const input = structuredClone(record);
      assertWritableNamespace(input.namespace);
      assertPluginDataSize(
        ctx.pluginId,
        input.namespace,
        input.key,
        input.value,
      );
      const failure = datasetFailure(
        "setPluginData",
        options.datasetPolicy?.(ctx.pluginId, input.namespace),
        ["set"],
        { value: input.value },
      );
      if (failure) throw new Error(failure.error);
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
    async getPluginData(namespace, key) {
      return store.getPluginData(ctx.sessionId, ctx.pluginId, namespace, key);
    },
    async listPluginData(namespace) {
      return store.listPluginData(ctx.sessionId, ctx.pluginId, namespace);
    },
  };
}
