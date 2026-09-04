/**
 * Unified plugin server entry — the `entry` PLUGIN.md frontmatter field.
 *
 * An entry module default-exports a factory `function (covel: PluginAPI)`
 * (sync or async) that registers the plugin's server-side capabilities
 * imperatively through one facade:
 *
 *   export default function (covel) {
 *     covel.registerTool(covel.toolkit.tool({ ... }));
 *     covel.on("PostLLMResponse", handler);
 *     covel.registerRpc("my-action", handler);
 *     covel.registerWires({ image: [myWire] });
 *   }
 *
 * Trust gating mirrors runtime handlers: builtin entries run at bootstrap;
 * community entries run on `ensurePluginEntry()` (memoized and
 * in-flight-deduped) after the server-code approval gate clears.
 */

import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import {
  getPluginTrustInfo,
  loadPluginEntryDefinition,
  type PluginEntryDefinition,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import {
  type HookPipeline,
  type PluginAPI,
  type PluginRpcRegistry,
  type PluginToolkit,
} from "@covel/runtime";
import { HOOK_EVENTS, type RpcTrustLevel } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  shortId,
  shortIdBatch,
  tool,
  withPendingProposals,
  type ToolModule,
} from "@covel/tools";
import { z } from "zod";
import { registerNamespaced } from "./plugin-wires.js";
import { scopeStoreToPlugin } from "./plugin-store-scope.js";

// `PluginAPI` / `PluginToolkit` (and the related option types) are the
// Public Plugin API — they live in @covel/runtime so plugin authors can
// import them. `buildApi` below is annotated `: PluginAPI`, so this
// implementation cannot drift from the published contract without a
// compile error.

export interface BootstrapPluginEntriesParams {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
  readonly toolMap: Map<string, ToolModule>;
  readonly localToolNames: Set<string>;
  /** Mutable: entry-registered tool names are discovered at invocation time. */
  readonly pluginToolAccess: Map<string, Set<string>>;
  readonly hookPipeline: HookPipeline;
  readonly rpcRegistry: PluginRpcRegistry;
  /** Fail-closed session authorization for community server code. */
  readonly isCommunityServerCodeApproved?: (
    sessionId: string | undefined,
    pluginId: string,
  ) => boolean | Promise<boolean>;
  /** Narrower grant used for lifecycle hook execution after import. */
  readonly isCommunityHookApproved?: (
    sessionId: string,
    pluginId: string,
  ) => boolean | Promise<boolean>;
}

export interface BootstrapPluginEntries {
  /** Deferred entry invocation — memoized per pluginId, safe to await repeatedly. */
  readonly ensurePluginEntry: (
    pluginId: string,
    sessionId?: string,
  ) => Promise<void>;
  /**
   * True when `pluginId` declares an `entry`, its trust is deferred
   * (community), and the entry has not been activated yet. The plugin-rpc
   * action-level path uses this to route an unregistered action through the
   * approval gate instead of a hard 404 — the action's registration lives
   * inside the not-yet-run entry.
   */
  readonly hasPendingEntry: (pluginId: string) => boolean;
}

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);

function isToolModule(value: unknown): value is ToolModule {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as Record<string, unknown>)._type === "covel-tool"
  );
}

export async function createBootstrapPluginEntries({
  discoveryMap,
  manifestCache,
  store,
  toolMap,
  localToolNames,
  pluginToolAccess,
  hookPipeline,
  rpcRegistry,
  isCommunityServerCodeApproved,
  isCommunityHookApproved,
}: BootstrapPluginEntriesParams): Promise<BootstrapPluginEntries> {
  const http = { fetchWithRetry, validateBaseUrl: validateBaseUrlForPlugin };
  const entryDefinitions = new Map<string, PluginEntryDefinition>();

  // Compile entry declarations once. Both the approval/pending path and actual
  // activation consume this exact definition, so metadata-only multi-runtime
  // roots cannot be visible to one path and absent from the other.
  for (const [pluginId, discovery] of discoveryMap) {
    const definition = await loadPluginEntryDefinition(
      discovery,
      manifestCache.get(pluginId) ?? [],
    );
    entryDefinitions.set(pluginId, definition);
    if (definition.rootManifestIssue) {
      console.warn(
        `[plugin-entry] ${path.relative(process.cwd(), definition.rootManifestIssue.path)}: failed to parse root PLUGIN.md for entry —`,
        definition.rootManifestIssue.message,
      );
    }
  }

  const buildApi = (pluginId: string, pluginRelPath: string): PluginAPI => {
    let hookSeq = 0;
    const trustInfo = getPluginTrustInfo(
      pluginId,
      discoveryMap.get(pluginId)?.source,
    );
    const pluginTrust: RpcTrustLevel = trustInfo.source;

    // Community entries get a pluginId-scoped store view; builtin entries keep
    // the raw store.
    const toolkit: PluginToolkit = {
      tool,
      z,
      shortId,
      shortIdBatch,
      withPendingProposals,
      store:
        pluginTrust === "community"
          ? scopeStoreToPlugin(store, pluginId, "plugin-entry")
          : store,
    };

    return {
      pluginId,
      toolkit,
      http,
      registerTool(toolModule) {
        if (!isToolModule(toolModule)) {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerTool() expects a ToolModule built with covel.toolkit.tool() — skipping`,
          );
          return;
        }
        // Reject collisions: a duplicate name would silently replace the
        // existing implementation globally — for a builtin name, `findTool`
        // resolves via builtinToolNames first and every runtime would get
        // the replacement, bypassing the plugin access boundary.
        if (toolMap.has(toolModule.name)) {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerTool("${toolModule.name}") collides with an existing tool — skipping`,
          );
          return;
        }
        toolMap.set(toolModule.name, toolModule);
        localToolNames.add(toolModule.name);
        let allowed = pluginToolAccess.get(pluginId);
        if (!allowed) {
          allowed = new Set();
          pluginToolAccess.set(pluginId, allowed);
        }
        allowed.add(toolModule.name);
      },
      on(event, handler, options) {
        if (!HOOK_EVENT_SET.has(event)) {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: unknown hook event "${event}" — skipping`,
          );
          return;
        }
        if (typeof handler !== "function") {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: on("${event}") expects a handler function — skipping`,
          );
          return;
        }
        hookSeq += 1;
        const sessionGuardedHandler: typeof handler = async (ctx, payload) => {
          if (
            pluginTrust === "community" &&
            !(await isCommunityHookApproved?.(ctx.sessionId, pluginId))
          ) {
            return { action: "continue" };
          }
          return handler(ctx, payload);
        };
        hookPipeline.register({
          id: `${pluginId}:${event}:entry#${hookSeq}`,
          event,
          pluginId,
          handler: sessionGuardedHandler,
          ...(options?.match ? { match: options.match } : {}),
          ...(typeof options?.timeoutMs === "number"
            ? { timeoutMs: options.timeoutMs }
            : {}),
          ...(options?.enforce ? { enforce: options.enforce } : {}),
        });
      },
      registerRpc(action, handler, options) {
        if (typeof handler !== "function") {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerRpc("${action}") expects a handler function — skipping`,
          );
          return;
        }
        try {
          rpcRegistry.registerPluginHandler(
            pluginId,
            action,
            handler,
            options ?? {},
            pluginTrust,
          );
        } catch (err) {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerRpc("${action}") failed —`,
            err instanceof Error ? err.message : err,
          );
        }
      },
      registerWires(wires) {
        if (!wires || typeof wires !== "object") {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerWires() expects { image?, speech?, transcription? } — skipping`,
          );
          return;
        }
        registerNamespaced(pluginId, pluginRelPath, wires);
      },
    };
  };

  const invokeEntryForPlugin = async (pluginId: string): Promise<void> => {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return;
    const definition = entryDefinitions.get(pluginId);
    if (!definition || definition.entryPaths.length === 0) return;

    const pluginRelPath = path.relative(
      process.cwd(),
      path.join(definition.pluginRoot, "PLUGIN.md"),
    );
    const api = buildApi(pluginId, pluginRelPath);

    for (const entryPath of definition.entryPaths) {
      const fullPath = path.resolve(definition.pluginRoot, entryPath);
      try {
        const rel = path.relative(definition.pluginRoot, fullPath);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: entry "${entryPath}" escapes the plugin root\n` +
              `Fix: Use a path relative to the plugin directory (no "../" traversal).`,
          );
          continue;
        }
        if (!fsSync.existsSync(fullPath)) {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: entry file not found — ${fullPath}\n` +
              `Fix: Create the file, or remove the entry field from PLUGIN.md.`,
          );
          continue;
        }
        const mod = await import(pathToFileURL(fullPath).href);
        const factory: unknown = mod.default;
        if (typeof factory !== "function") {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: entry must default-export a function (covel) => { ... }`,
          );
          continue;
        }
        await factory(api);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[plugin-entry] ${pluginRelPath}: failed to run entry "${entryPath}" — ${message}`,
        );
      }
    }
  };

  // Builtin entries run at bootstrap so their capabilities are
  // available from the first turn.
  for (const [pluginId, discovery] of discoveryMap) {
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (!trust.autoLoad) continue;
    await invokeEntryForPlugin(pluginId);
  }

  const invokedPluginIds = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();

  // Community entry hooks exist only after the entry is approved and invoked;
  // lifecycle events emitted before activation are intentionally not replayed.
  const ensurePluginEntry = async (
    pluginId: string,
    sessionId?: string,
  ): Promise<void> => {
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return;
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (trust.autoLoad) {
      // Already handled in the bootstrap loop above.
      invokedPluginIds.add(pluginId);
      return;
    }
    if (!(await isCommunityServerCodeApproved?.(sessionId, pluginId))) {
      throw new Error(
        `[plugin-entry] ${pluginId}: community server code requires explicit approval for session ${sessionId ?? "<missing>"}`,
      );
    }
    if (invokedPluginIds.has(pluginId)) return;
    const pending = inFlight.get(pluginId);
    if (pending) return pending;

    const promise = (async () => {
      try {
        await invokeEntryForPlugin(pluginId);
        invokedPluginIds.add(pluginId);
      } finally {
        inFlight.delete(pluginId);
      }
    })();
    inFlight.set(pluginId, promise);
    return promise;
  };

  const hasPendingEntry = (pluginId: string): boolean => {
    if (invokedPluginIds.has(pluginId)) return false;
    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return false;
    // Builtin entries ran at boot, so a miss is a genuine 404.
    if (getPluginTrustInfo(pluginId, discovery.source).autoLoad) return false;
    return (entryDefinitions.get(pluginId)?.entryPaths.length ?? 0) > 0;
  };

  return { ensurePluginEntry, hasPendingEntry };
}
