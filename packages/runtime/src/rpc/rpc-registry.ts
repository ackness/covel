/**
 * Plugin RPC registry.
 *
 * Holds the lookup table for RPC handlers exposed via
 * `POST /api/sessions/:id/plugin-rpc`. Plugin entry modules register inline
 * handlers, while framework defaults are registered eagerly at bootstrap.
 */

import type { RpcHandlerStore, RpcTrustLevel } from "@covel/shared";

/**
 * Trust ranking — higher rank = more permissive (auto-allows the call).
 *
 * The approval gate uses this so an entry's requested `trustLevel` can
 * only ever **raise restrictions** relative to the plugin's source trust:
 * a community plugin can't quietly opt itself into `builtin` and bypass
 * the dialog. See CRITICAL-1 fix in the code review report.
 */
const TRUST_RANK: Readonly<Record<RpcTrustLevel, number>> = {
  community: 0,
  builtin: 1,
};

/**
 * Resolve the effective trust for a plugin action.
 *
 *   - If the registration does not set `trustLevel`, fall back to the
 *     plugin's source trust.
 *   - If the registration sets a level **at or below** the plugin's source
 *     trust (i.e., equal or more restrictive), honour it — this is the
 *     intended use case (a builtin plugin marking one action as
 *     "community-approval-required").
 *   - If the manifest tries to declare a level **above** the plugin's
 *     source trust (escalation), clamp to the plugin source and emit a
 *     warning so the operator notices the rejected attempt.
 */
function resolveActionTrust(
  pluginId: string,
  action: string,
  options: { readonly trustLevel?: RpcTrustLevel },
  pluginTrust: RpcTrustLevel,
): RpcTrustLevel {
  if (!options.trustLevel) return pluginTrust;
  if (TRUST_RANK[options.trustLevel] > TRUST_RANK[pluginTrust]) {
    console.warn(
      `[plugin-rpc] ${pluginId}::${action} declared trustLevel=${options.trustLevel} ` +
        `but plugin source is ${pluginTrust}; clamping to ${pluginTrust}.`,
    );
    return pluginTrust;
  }
  return options.trustLevel;
}

/** Resolved RPC handler signature. */
export type RpcHandler = (
  payload: unknown,
  context: RpcHandlerContext,
) => Promise<unknown>;

/**
 * Context handed to every RPC handler. The framework guarantees:
 *   - `sessionId` exists in the store
 *   - `pluginId` is whatever the request named (no implicit rewrite)
 *   - `store` is the same backend the rest of the request uses, exposed as
 *     a narrow structural interface (`RpcHandlerStore`) so plugins keep
 *     type checking without depending on `@covel/store`.
 */
export interface RpcHandlerContext {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly action?: string;
  readonly runtimeId?: string;
  readonly store: RpcHandlerStore;
  /**
   * Resolved locale for the session (request → session → world → app default).
   * Framework default handlers (e.g. `submit-form`) use it to localize the
   * narrative text they produce. Optional: undefined falls back to zh-CN.
   * Flows in via `...context` spread in the rpc-executor — no executor change.
   */
  readonly locale?: string;
  /** SSE push (no-op for sync mode). */
  readonly emit?: (event: { type: string; data: unknown }) => void;
}

/**
 * One entry in the registry. Both plugin and framework registrations keep an
 * inline handler; plugin entries additionally carry their namespace id.
 */
export interface RpcRegistryEntry {
  readonly action: string;
  readonly pluginId?: string;
  readonly trustLevel: RpcTrustLevel;
  readonly description?: string;
  readonly handler: RpcHandler;
}

export interface PluginRpcRegistry {
  /**
   * Register a plugin action from its entry module. Throws if the
   * (pluginId, action) pair is already registered.
   */
  registerPluginHandler(
    pluginId: string,
    action: string,
    handler: RpcHandler,
    options: {
      readonly description?: string;
      readonly trustLevel?: RpcTrustLevel;
    },
    pluginTrust: RpcTrustLevel,
  ): void;
  /** Register a framework default. Always succeeds; later registrations overwrite. */
  registerFrameworkDefault(
    action: string,
    handler: RpcHandler,
    options?: { description?: string },
  ): void;
  /** Look up a plugin action. Returns undefined when missing. */
  getPluginAction(
    pluginId: string,
    action: string,
  ): RpcRegistryEntry | undefined;
  /** Look up a framework default. */
  getFrameworkDefault(action: string): RpcRegistryEntry | undefined;
  /** Snapshot of all entries for debug / introspection. */
  list(): readonly RpcRegistryEntry[];
}

export function createPluginRpcRegistry(): PluginRpcRegistry {
  const pluginEntries = new Map<string, RpcRegistryEntry>(); // key = `${pluginId}::${action}`
  const frameworkEntries = new Map<string, RpcRegistryEntry>();

  return {
    registerPluginHandler(pluginId, action, handler, options, pluginTrust) {
      const key = `${pluginId}::${action}`;
      if (pluginEntries.has(key)) {
        throw new Error(
          `[plugin-rpc] duplicate registration: plugin "${pluginId}" already declares action "${action}"`,
        );
      }
      pluginEntries.set(key, {
        action,
        pluginId,
        trustLevel: resolveActionTrust(pluginId, action, options, pluginTrust),
        description: options.description,
        handler,
      });
    },

    registerFrameworkDefault(action, handler, options) {
      frameworkEntries.set(action, {
        action,
        trustLevel: "builtin",
        description: options?.description,
        handler,
      });
    },

    getPluginAction(pluginId, action) {
      return pluginEntries.get(`${pluginId}::${action}`);
    },

    getFrameworkDefault(action) {
      return frameworkEntries.get(action);
    },

    list() {
      return [...frameworkEntries.values(), ...pluginEntries.values()];
    },
  };
}
