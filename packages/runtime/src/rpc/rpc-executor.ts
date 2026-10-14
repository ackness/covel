/**
 * Plugin RPC dispatcher.
 *
 * Resolves an `{ pluginId, action }` request against the registry, runs its
 * inline handler, and returns the result synchronously.
 *
 * Dispatch is always synchronous. Long-running work goes through a background
 * job whose progress reaches the UI as `plugin-data.changed` SSE events.
 *
 * A handler has a time limit. When it passes, the dispatch fails, the
 * handler's `signal` aborts and its store stops accepting calls, so the caller
 * can release the session lock without a late write landing after it. Writes
 * the handler made before the limit stay: they are immediate, not proposals.
 *
 * Resolution for action-level dispatch: `FRAMEWORK_PLUGIN_ID` names the
 * framework defaults (`registry.getFrameworkDefault`), such as the actions
 * behind the built-in slash commands; any other ID names that plugin's own
 * actions (`registry.getPluginAction`). The two never fall back to each
 * other, so the route's trust decision and the handler that runs agree.
 *
 * Runtime-level dispatch is handled separately (`runtimeId` set) by the
 * caller — the dispatcher just exposes the registry-aware path here.
 */

import { FRAMEWORK_PLUGIN_ID, type RpcHandlerStore } from "@covel/shared";
import type {
  PluginRpcRegistry,
  RpcHandlerContext,
  RpcRegistryEntry,
} from "./rpc-registry.js";
import { createPluginRandom } from "../function-runtime/plugin-random.js";
import { RpcValidationError } from "./rpc-validation-error.js";

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
  /** Time limit of one handler. Default {@link DEFAULT_RPC_HANDLER_TIMEOUT_MS}. */
  readonly handlerTimeoutMs?: number;
}

/** An action runs under the session lock; this bounds how long it holds it. */
export const DEFAULT_RPC_HANDLER_TIMEOUT_MS = 30_000;

export class RpcDispatchError extends Error {
  constructor(
    message: string,
    public readonly code:
      "unknown-plugin" | "unknown-action" | "handler-threw" | "handler-timeout",
  ) {
    super(message);
    this.name = "RpcDispatchError";
  }
}

/**
 * Wrap a handler's store so it can be closed: a call after `close()` is
 * refused, and `close()` waits for calls already in flight, so none of them
 * writes after the caller has moved on.
 */
function closableStore(
  store: RpcHandlerStore,
  label: string,
): {
  readonly store: RpcHandlerStore;
  close(): Promise<void>;
} {
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();
  const guard =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (closed) {
        console.warn(
          `[plugin-rpc] refused a store call from ${label} after the action ended`,
        );
        const refused = Promise.reject<R>(
          new Error(
            "[plugin-rpc] the action has ended; its store accepts no more calls",
          ),
        );
        // A call the handler did not await must not become an unhandled
        // rejection that stops the server; one it awaits still throws.
        refused.catch(() => undefined);
        return refused;
      }
      const pending = Promise.resolve().then(() => call(...args));
      inFlight.add(pending);
      void pending.then(
        () => inFlight.delete(pending),
        () => inFlight.delete(pending),
      );
      return pending;
    };
  const { setPluginData, getPluginData, listPluginData } = store;
  return {
    store: {
      getSession: guard(() => store.getSession()),
      listTurnMessages: guard((limit?: number) =>
        store.listTurnMessages(limit),
      ),
      ...(setPluginData
        ? { setPluginData: guard(setPluginData.bind(store)) }
        : {}),
      ...(getPluginData
        ? { getPluginData: guard(getPluginData.bind(store)) }
        : {}),
      ...(listPluginData
        ? { listPluginData: guard(listPluginData.bind(store)) }
        : {}),
    },
    async close() {
      closed = true;
      await Promise.allSettled([...inFlight]);
    },
  };
}

export function createRpcExecutor(deps: RpcDispatchDeps) {
  const handlerTimeoutMs =
    deps.handlerTimeoutMs ?? DEFAULT_RPC_HANDLER_TIMEOUT_MS;
  if (!Number.isFinite(handlerTimeoutMs) || handlerTimeoutMs <= 0) {
    throw new RangeError("handlerTimeoutMs must be positive");
  }
  function lookupEntry(pluginId: string, action: string): RpcRegistryEntry {
    const entry =
      pluginId === FRAMEWORK_PLUGIN_ID
        ? deps.registry.getFrameworkDefault(action)
        : deps.registry.getPluginAction(pluginId, action);
    if (entry) return entry;

    throw new RpcDispatchError(
      `[plugin-rpc] unknown action "${action}" (pluginId="${pluginId}")`,
      "unknown-action",
    );
  }

  return {
    /** Dispatch an action-level RPC and await the result. */
    async dispatch(
      req: RpcDispatchRequest,
      // The executor supplies the scoped store guard and `random` itself.
      context: Omit<
        RpcHandlerContext,
        "pluginId" | "action" | "runtimeId" | "random"
      >,
    ): Promise<RpcDispatchResult> {
      const entry = lookupEntry(req.pluginId, req.action);
      const store = closableStore(
        context.store,
        `${req.pluginId}/${req.action}`,
      );
      const controller = new AbortController();
      const fullContext: RpcHandlerContext = {
        ...context,
        store: store.store,
        signal: controller.signal,
        pluginId: req.pluginId,
        action: req.action,
        random: createPluginRandom({
          sessionId: context.sessionId,
          pluginId: req.pluginId,
          stream: `rpc:${req.action}`,
        }),
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RpcDispatchError(
                `[plugin-rpc] handler for "${req.action}" (pluginId="${req.pluginId}") did not finish within ${handlerTimeoutMs}ms; writes it made before then are kept`,
                "handler-timeout",
              ),
            ),
          handlerTimeoutMs,
        );
      });
      const handled = (async () => entry.handler(req.payload, fullContext))();
      try {
        const result = await Promise.race([handled, timedOut]);
        return { entry, result };
      } catch (err) {
        if (err instanceof RpcDispatchError && err.code === "handler-timeout") {
          // Close admission before synchronous abort listeners can call the store.
          const settlingStore = store.close();
          controller.abort(err);
          await settlingStore;
          // The handler may still settle; its outcome no longer matters.
          handled.catch(() => undefined);
          throw err;
        }
        if (err instanceof RpcDispatchError) throw err;
        // Preserve typed validation errors so the HTTP layer can map them
        // to 400 responses.
        if (err instanceof RpcValidationError) throw err;
        throw new RpcDispatchError(
          `[plugin-rpc] handler for "${req.action}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "handler-threw",
        );
      } finally {
        clearTimeout(timer);
        // Close on every outcome: nothing the handler left running may reach
        // the store once the caller releases the session lock.
        await store.close();
      }
    },

    lookupEntry,
  };
}

export type RpcExecutor = ReturnType<typeof createRpcExecutor>;
