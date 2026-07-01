import type { EventBus } from "@covel/events";
import type {
  DataStore,
  PluginDataRecord,
  StoreTransaction,
} from "@covel/store";

function emitPluginDataChangedEvent(
  eventBus: EventBus,
  pluginId: string,
  sessionId: string,
  changes: readonly {
    namespace: string;
    key: string;
    value: unknown;
    operation: "set" | "delete";
  }[],
): void {
  if (changes.length === 0) return;
  eventBus.emit({
    id: crypto.randomUUID(),
    type: "event",
    topic: "plugin",
    payload: {
      _subType: "plugin-data.changed",
      pluginId,
      changes,
      // The proxy is the single emission layer for plugin-data.changed.
      // Commit-chain writes and direct store writes both pass through here.
      source: "store-proxy",
    },
    sessionId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Wrap a DataStore with a transparent Proxy that emits a `plugin-data.changed`
 * event after every `setPluginData` / `setPluginDataBatch` / `deletePluginData`
 * call, regardless of caller (kernel commit pipeline, plugin RPC handlers,
 * plugin-local tool direct writes, admin API endpoints).
 *
 * Governance contract:
 * - Proposal-backed plugin-data writes now enter through the Session Kernel
 *   commit pipeline before the proxy emits `plugin-data.changed`.
 * - Direct store callers still receive the same event stream, so API routes,
 *   function handlers, and internal mirrors keep the existing live-update
 *   behaviour.
 * - Observability stays complete: every write produces a
 *   `plugin-data.changed` SessionEvent persisted by eventBus.persistEvent
 *   into the `events` table and pushed to `/events/stream` subscribers.
 */
export function wrapStoreWithPluginDataEvents(
  baseStore: DataStore,
  eventBus: EventBus,
): DataStore {
  return new Proxy(baseStore, {
    get(target, prop, receiver) {
      if (prop === "setPluginData") {
        return async (record: PluginDataRecord): Promise<void> => {
          await target.setPluginData(record);
          emitPluginDataChangedEvent(
            eventBus,
            record.pluginId,
            record.sessionId,
            [
              {
                namespace: record.namespace,
                key: record.key,
                value: record.value,
                operation: "set",
              },
            ],
          );
        };
      }

      if (prop === "setPluginDataBatch") {
        return async (records: readonly PluginDataRecord[]): Promise<void> => {
          await target.setPluginDataBatch(records);
          // Group by pluginId to emit one event per plugin.
          const byPlugin = new Map<
            string,
            {
              sessionId: string;
              changes: {
                namespace: string;
                key: string;
                value: unknown;
                operation: "set" | "delete";
              }[];
            }
          >();
          for (const r of records) {
            let entry = byPlugin.get(r.pluginId);
            if (!entry) {
              entry = { sessionId: r.sessionId, changes: [] };
              byPlugin.set(r.pluginId, entry);
            }
            entry.changes.push({
              namespace: r.namespace,
              key: r.key,
              value: r.value,
              operation: "set",
            });
          }
          for (const [pluginId, { sessionId, changes }] of byPlugin) {
            emitPluginDataChangedEvent(eventBus, pluginId, sessionId, changes);
          }
        };
      }

      // The commit pipeline prefers `withTransaction` (SQLite/PG). Its handlers
      // write through the tx-scoped store view, which is NOT this proxy — so
      // proposal-backed plugin-data writes (e.g. scene-prompts' plugin.data.batch)
      // would commit without ever emitting `plugin-data.changed`, leaving the
      // live UI un-refreshed until a page reload re-reads the DB. Wrap the tx
      // handed to the callback with the same proxy so those writes emit too.
      if (prop === "withTransaction") {
        if (typeof target.withTransaction !== "function") {
          return target.withTransaction;
        }
        return <T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> =>
          target.withTransaction!((tx) =>
            fn(
              wrapStoreWithPluginDataEvents(
                tx as unknown as DataStore,
                eventBus,
              ) as unknown as StoreTransaction,
            ),
          );
      }

      if (prop === "deletePluginData") {
        return async (
          sessionId: string,
          pluginId: string,
          namespace: string,
          key: string,
        ): Promise<void> => {
          await target.deletePluginData(sessionId, pluginId, namespace, key);
          emitPluginDataChangedEvent(eventBus, pluginId, sessionId, [
            {
              namespace,
              key,
              value: null,
              operation: "delete",
            },
          ]);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}
