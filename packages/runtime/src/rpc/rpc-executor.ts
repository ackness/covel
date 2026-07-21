/**
 * Plugin RPC dispatcher.
 *
 * Resolves an `{ pluginId, action?, runtimeId? }` request against the
 * registry, loads the handler module if needed, and runs it with the
 * supplied context. Returns either a sync result or, for streaming
 * handlers, a generator the caller can pipe to SSE.
 *
 * Resolution order for action-level dispatch:
 *   1. Plugin-declared action (`registry.getPluginAction`)
 *   2. Framework default (`registry.getFrameworkDefault`) — covers
 *      `submit-form`, `cancel`, etc.
 *
 * Runtime-level dispatch is handled separately (`runtimeId` set) by the
 * caller — the dispatcher just exposes the registry-aware path here.
 */

import type {
  PluginRpcRegistry,
  RpcHandler,
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
  /**
   * Loads a plugin RPC handler module from disk. The caller (server bootstrap)
   * supplies this so the runtime package stays free of fs imports. The path
   * is the `handlerPath` recorded in the registry entry, resolved against
   * the plugin's root directory.
   */
  readonly loadHandler: (
    pluginId: string,
    handlerPath: string,
  ) => Promise<RpcHandler>;
}

export class RpcDispatchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unknown-plugin"
      | "unknown-action"
      | "handler-load-failed"
      | "handler-threw",
  ) {
    super(message);
    this.name = "RpcDispatchError";
  }
}

export function createRpcExecutor(deps: RpcDispatchDeps) {
  const handlerCache = new Map<string, RpcHandler>();

  async function resolveHandler(entry: RpcRegistryEntry): Promise<RpcHandler> {
    // Framework defaults inline the handler.
    if (entry.handler) return entry.handler;

    if (!entry.pluginId || !entry.handlerPath) {
      throw new RpcDispatchError(
        `[plugin-rpc] entry "${entry.action}" has neither inline handler nor handlerPath`,
        "handler-load-failed",
      );
    }

    const cacheKey = `${entry.pluginId}::${entry.handlerPath}`;
    const cached = handlerCache.get(cacheKey);
    if (cached) return cached;

    try {
      const handler = await deps.loadHandler(entry.pluginId, entry.handlerPath);
      handlerCache.set(cacheKey, handler);
      return handler;
    } catch (err) {
      throw new RpcDispatchError(
        `[plugin-rpc] failed to load handler ${entry.handlerPath} for plugin ${entry.pluginId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "handler-load-failed",
      );
    }
  }

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
      const handler = await resolveHandler(entry);

      const fullContext: RpcHandlerContext = {
        ...context,
        pluginId: req.pluginId,
        action: req.action,
      };

      try {
        const result = await handler(req.payload, fullContext);
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
