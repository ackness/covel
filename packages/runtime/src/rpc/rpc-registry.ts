/**
 * PR-3: Plugin RPC registry.
 *
 * Holds the lookup table for RPC handlers exposed via
 * `POST /api/sessions/:id/plugin-rpc`. Two kinds of registrations:
 *
 *   1. **Plugin-declared actions** — discovered from `manifest.rpc` during
 *      plugin load. Handlers are loaded lazily on first dispatch.
 *
 *   2. **Framework default actions** — registered eagerly at bootstrap.
 *      Always available regardless of which plugins are loaded. Requests
 *      address them with `pluginId: "framework"`.
 *
 * The registry does not resolve handlers (i.e. does not `import()` modules);
 * it only stores the declarations and exposes a lookup interface. The
 * dispatcher calls `loadHandler` provided by the caller to actually execute.
 */

import type {
  RpcActionDecl,
  RpcHandlerStore,
  RpcTrustLevel,
} from "@covel/shared";

/**
 * Trust ranking — higher rank = more permissive (auto-allows the call).
 *
 * The PR-7 approval gate uses this so plugin-declared `decl.trustLevel` can
 * only ever **raise restrictions** relative to the plugin's source trust:
 * a community plugin can't quietly opt itself into `builtin` and bypass
 * the dialog. See CRITICAL-1 fix in the code review report.
 */
const TRUST_RANK: Readonly<Record<RpcTrustLevel, number>> = {
  community: 0,
  official: 1,
  builtin: 2,
};

/**
 * Resolve the effective trust for a plugin-declared action.
 *
 *   - If the manifest does not set `decl.trustLevel`, fall back to the
 *     plugin's source trust.
 *   - If the manifest sets a level **at or below** the plugin's source
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
  decl: RpcActionDecl,
  pluginTrust: RpcTrustLevel,
): RpcTrustLevel {
  if (!decl.trustLevel) return pluginTrust;
  if (TRUST_RANK[decl.trustLevel] > TRUST_RANK[pluginTrust]) {
    console.warn(
      `[plugin-rpc] ${pluginId}::${action} declared trustLevel=${decl.trustLevel} ` +
        `but plugin source is ${pluginTrust}; clamping to ${pluginTrust}.`,
    );
    return pluginTrust;
  }
  return decl.trustLevel;
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
  /** SSE push (no-op for sync mode). */
  readonly emit?: (event: { type: string; data: unknown }) => void;
}

/**
 * One entry in the registry. Plugin-declared entries have a `pluginId` and
 * lazy `handlerPath`; framework-default entries inline the handler directly.
 */
export interface RpcRegistryEntry {
  readonly action: string;
  readonly pluginId?: string;
  readonly trustLevel: RpcTrustLevel;
  readonly streaming: boolean;
  readonly description?: string;
  /** For plugin-declared actions: relative path on disk to the handler module. */
  readonly handlerPath?: string;
  /** For framework-default actions: inline implementation. */
  readonly handler?: RpcHandler;
}

export interface PluginRpcRegistry {
  /** Register a plugin-declared action. Throws if the (pluginId, action) pair is already registered. */
  registerPluginAction(
    pluginId: string,
    action: string,
    decl: RpcActionDecl,
    pluginTrust: RpcTrustLevel,
  ): void;
  /** Register a framework default. Always succeeds; later registrations overwrite. */
  registerFrameworkDefault(
    action: string,
    handler: RpcHandler,
    options?: { description?: string; streaming?: boolean },
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
    registerPluginAction(pluginId, action, decl, pluginTrust) {
      const key = `${pluginId}::${action}`;
      if (pluginEntries.has(key)) {
        throw new Error(
          `[plugin-rpc] duplicate registration: plugin "${pluginId}" already declares action "${action}"`,
        );
      }
      pluginEntries.set(key, {
        action,
        pluginId,
        trustLevel: resolveActionTrust(pluginId, action, decl, pluginTrust),
        streaming: decl.streaming ?? false,
        description: decl.description,
        handlerPath: decl.handler,
      });
    },

    registerFrameworkDefault(action, handler, options) {
      frameworkEntries.set(action, {
        action,
        trustLevel: "builtin",
        streaming: options?.streaming ?? false,
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
