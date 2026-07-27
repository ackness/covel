/**
 * Public Plugin API — the types a plugin's unified server `entry` module is
 * written against.
 *
 * A PLUGIN.md `entry` module default-exports a factory (sync or async) that
 * receives the {@link PluginAPI} facade and registers the plugin's
 * server-side capabilities imperatively:
 *
 *   // JSDoc: @type {import('@covel/runtime').PluginEntryFactory}
 *   export default function (covel) {
 *     covel.registerTool(covel.toolkit.tool({ ... }));
 *     covel.on("PostLLMResponse", handler);
 *     covel.registerRpc("my-action", handler);
 *     covel.registerWires({ image: [myWire] });
 *   }
 *
 * These types are the stable contract between the framework and plugin
 * authors. The server's implementation (apps/server plugin-entry bootstrap)
 * is compile-time checked against them, so the two cannot drift silently.
 */

import type {
  fetchWithRetry,
  validateBaseUrlForPlugin,
  WireModuleShape,
} from "@covel/ai-provider";
import type { HookEnforce, HookEventName, RpcTrustLevel } from "@covel/shared";
import type { DataStore } from "@covel/store";
import type {
  shortId,
  shortIdBatch,
  tool,
  withPendingProposals,
  ToolModule,
} from "@covel/tools";
import type { z } from "zod";
import type { HookHandler } from "./hooks/types.js";
import type { RpcHandler } from "./rpc/rpc-registry.js";

/**
 * The store surface the Public Plugin API guarantees to an entry factory:
 * read-only.
 *
 * - `getPluginData` / `listPluginData` — for community plugins these are
 *   clamped to the plugin's OWN `pluginId` at runtime (any caller-supplied
 *   id is ignored).
 * - `getSession` / `listTurnMessages` / `listRecentTurnMessages` — read-only
 *   lookups, typically driven by the `sessionId` a hook/RPC context hands in.
 *
 * There are deliberately NO write methods here. Entry factories run at
 * activation time with no request session to scope a write to, so all writes
 * must flow through governed, session-bound surfaces instead: proposals
 * (`withPendingProposals`) from tools/runtimes, or the session-scoped store
 * an RPC handler receives per dispatch.
 *
 * Builtin/official plugins receive the full `DataStore` at runtime (parity
 * with the legacy `tools.local` factory) because they implement framework
 * primitives — but the published contract is this view, so third-party code
 * cannot depend on methods the community proxy denies.
 */
export type PluginStoreView = Pick<
  DataStore,
  | "getPluginData"
  | "listPluginData"
  | "getSession"
  | "listTurnMessages"
  | "listRecentTurnMessages"
>;

/**
 * Helper bag handed to entry factories — the same surface the legacy
 * `tools.local` factory injection provided, so migrated tool files keep
 * their `({ tool, z, store, ... })` signature unchanged.
 *
 * `store` is the read-only {@link PluginStoreView}; writes go through
 * proposals or request-time scoped stores (see the view's docs).
 */
export interface PluginToolkit {
  readonly tool: typeof tool;
  readonly z: typeof z;
  readonly shortId: typeof shortId;
  readonly shortIdBatch: typeof shortIdBatch;
  readonly withPendingProposals: typeof withPendingProposals;
  readonly store: PluginStoreView;
}

export interface PluginHookOptions {
  /** Payload predicate — handler only fires when it returns true. */
  readonly match?: (payload: unknown) => boolean;
  readonly timeoutMs?: number;
  readonly enforce?: HookEnforce;
}

export interface PluginRpcOptions {
  readonly description?: string;
  /** May only restrict (never escalate) the plugin's source trust. */
  readonly trustLevel?: RpcTrustLevel;
}

/** The facade an entry factory receives. */
export interface PluginAPI {
  readonly pluginId: string;
  readonly toolkit: PluginToolkit;
  /** SSRF-guarded fetch helpers for wire implementations. */
  readonly http: {
    readonly fetchWithRetry: typeof fetchWithRetry;
    readonly validateBaseUrl: typeof validateBaseUrlForPlugin;
  };
  /** Register a local tool (scoped to this plugin, like `tools.local`). */
  registerTool(toolModule: ToolModule): void;
  /** Register a lifecycle hook handler (16 events, same semantics as `hooks`). */
  on(
    event: HookEventName,
    handler: HookHandler,
    options?: PluginHookOptions,
  ): void;
  /** Register an RPC action with an inline handler (same gate as `rpc`). */
  registerRpc(
    action: string,
    handler: RpcHandler,
    options?: PluginRpcOptions,
  ): void;
  /** Register media wires (namespaced `<pluginId>/<wireId>`, like `wires`). */
  registerWires(wires: WireModuleShape): void;
}

/** Signature of an entry module's default export. */
export type PluginEntryFactory = (covel: PluginAPI) => void | Promise<void>;
