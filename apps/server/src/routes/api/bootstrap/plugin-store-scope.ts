import type { DataStore } from "@covel/store";

/**
 * Community-facing plugin store view: default-deny every method.
 *
 * Both community server-code entry points — the unified `entry` module and the
 * legacy `tools.local` factory — close over their injected store for the
 * lifetime of the process, so this view must be safe on its own:
 *  - EVERY read and write — including own-namespace `setPluginData` /
 *    `setPluginDataBatch` / `deletePluginData` — and every other DataStore
 *    method throws a clear error. Community writes must flow through
 *    governed, session-bound surfaces: proposals → validate → commit from
 *    tools/runtimes, or the per-dispatch `createRpcHandlerStoreView` handed
 *    to RPC handlers at request time.
 *
 * Session scoping is NOT possible here (this code registers at activation
 * time, before any request) — that is exactly why writes are denied outright
 * rather than clamped: a registration-time operation cannot be bound to a
 * request session, so there is no safe scope for it. Request/runtime handlers
 * receive their own session-scoped store surfaces.
 *
 * @param context - Caller label for the thrown message, so an author can tell
 *   which loading path denied them (`plugin-entry` vs `local-tools`).
 */
export function scopeStoreToPlugin(
  store: DataStore,
  pluginId: string,
  context: string,
): DataStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // Non-methods forward untouched — this keeps `await`'s `then` probe,
      // Symbol.toStringTag, etc. working on the proxied store.
      if (typeof value !== "function") return value;
      return () => {
        throw new Error(
          `[${context}] ${pluginId}: store.${String(prop)}() is not available to a community plugin toolkit — ` +
            `writes must go through proposals (or the session-scoped RPC store at dispatch time); ` +
            `reads must use a request/runtime-scoped context`,
        );
      };
    },
  });
}
