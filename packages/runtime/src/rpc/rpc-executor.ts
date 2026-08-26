/**
 * Plugin RPC dispatcher.
 *
 * Resolves an `{ pluginId, action }` request against the registry, runs its
 * inline handler, and returns the result synchronously.
 *
 * Dispatch is always synchronous. Long-running work goes through a background
 * job whose progress reaches the UI as `plugin-data.changed` SSE events.
 *
 * Resolution order for action-level dispatch:
 *   1. Plugin-declared action (`registry.getPluginAction`)
 *   2. Framework default (`registry.getFrameworkDefault`) — currently
 *      `submit-form` is the only one registered.
 *
 * Runtime-level dispatch is handled separately (`runtimeId` set) by the
 * caller — the dispatcher just exposes the registry-aware path here.
 */

import type {
  PluginRpcRegistry,
  RpcHandlerContext,
  RpcRegistryEntry,
} from "./rpc-registry.js";

export interface RpcDispatchRequest {
  readonly pluginId: string;
  readonly action: string;
  readonly payload: unknown;
}

export interface RpcDispatchResult {
  readonly entry: RpcRegistryEntry;
  readonly result: unknown;
}

export interface RpcDispatchDeps {
  readonly registry: PluginRpcRegistry;
}

export class RpcDispatchError extends Error {
  constructor(
    message: string,
    public readonly code: "unknown-plugin" | "unknown-action" | "handler-threw",
  ) {
    super(message);
    this.name = "RpcDispatchError";
  }
}

export function createRpcExecutor(deps: RpcDispatchDeps) {
  function lookupEntry(pluginId: string, action: string): RpcRegistryEntry {
    // Plugin-declared takes precedence over framework defaults so plugins
    // can override built-ins for their own pluginId namespace.
    const pluginEntry = deps.registry.getPluginAction(pluginId, action);
    if (pluginEntry) return pluginEntry;

    const frameworkEntry = deps.registry.getFrameworkDefault(action);
    if (frameworkEntry) return frameworkEntry;

    throw new RpcDispatchError(
      `[plugin-rpc] unknown action "${action}" (pluginId="${pluginId}")`,
      "unknown-action",
    );
  }

  return {
    /** Dispatch an action-level RPC and await the result. */
    async dispatch(
      req: RpcDispatchRequest,
      context: Omit<RpcHandlerContext, "pluginId" | "action" | "runtimeId">,
    ): Promise<RpcDispatchResult> {
      const entry = lookupEntry(req.pluginId, req.action);
      const fullContext: RpcHandlerContext = {
        ...context,
        pluginId: req.pluginId,
        action: req.action,
      };

      try {
        const result = await entry.handler(req.payload, fullContext);
        return { entry, result };
      } catch (err) {
        if (err instanceof RpcDispatchError) throw err;
        // Preserve typed validation errors so the HTTP layer can map them
        // to 400 responses. The runtime package re-exports RpcValidationError
        // alongside this executor — we detect it by name to avoid a
        // direct import cycle with rpc-defaults/.
        if (err instanceof Error && err.name === "RpcValidationError") {
          throw err;
        }
        throw new RpcDispatchError(
          `[plugin-rpc] handler for "${req.action}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "handler-threw",
        );
      }
    },

    lookupEntry,
  };
}

export type RpcExecutor = ReturnType<typeof createRpcExecutor>;
