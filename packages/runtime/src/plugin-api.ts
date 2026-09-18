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
 * authors. The server bootstrap implements this facade; capability behavior
 * is also checked by integration tests at activation and invocation.
 */

import type {
  fetchWithRetry,
  validateBaseUrlForPlugin,
  WireModuleShape,
} from "@covel/ai-provider";
import type { HookEnforce, HookEventName, RpcTrustLevel } from "@covel/shared";
import type {
  shortId,
  shortIdBatch,
  tool,
  withPendingProposals,
  ToolModule,
} from "@covel/tools";
import type { z } from "zod";
import type { HookHandler } from "./hooks/types.js";
import type { FormValidator } from "./rpc/form-validator.js";
import type { RpcHandler } from "./rpc/rpc-registry.js";

/**
 * Pure helpers for entry factories. State reads belong to a tool's invocation
 * context; writes are proposals or request-scoped RPC operations.
 */
export interface PluginToolkit {
  readonly tool: typeof tool;
  readonly z: typeof z;
  readonly shortId: typeof shortId;
  readonly shortIdBatch: typeof shortIdBatch;
  readonly withPendingProposals: typeof withPendingProposals;
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

/**
 * The facade an entry factory receives. Registrations are staged until all
 * entries of this plugin succeed, then published as one synchronous batch.
 * Register only while the factory is running; late registrations are rejected.
 * Initialization failures discard the batch and permit a later activation retry.
 */
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
  /** Validate this plugin's committed forms before accepting input; return an error or undefined. */
  registerFormValidator(name: string, validator: FormValidator): void;
  /** Register media wires (namespaced `<pluginId>/<wireId>`, like `wires`). */
  registerWires(wires: WireModuleShape): void;
}

/** Signature of an entry module's default export. */
export type PluginEntryFactory = (covel: PluginAPI) => void | Promise<void>;
