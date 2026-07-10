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
 * This is the successor of the four legacy registration fields
 * (`tools.local`, `hooks`, `rpc`, `wires`), which keep working for one
 * deprecation cycle (warned once per plugin at boot).
 *
 * Trust gating mirrors local-tools.ts / plugin-wires.ts: builtin/official
 * entries run at bootstrap; community entries run on `ensurePluginEntry()`
 * (memoized, in-flight-deduped) — wired into the same activation seams as
 * local tools and wires.
 */

import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import {
  getPluginTrustInfo,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import type {
  HookHandler,
  HookPipeline,
  PluginRpcRegistry,
  RpcHandler,
} from "@covel/runtime";
import {
  HOOK_EVENTS,
  type HookEnforce,
  type HookEventName,
  type RpcTrustLevel,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  shortId,
  shortIdBatch,
  tool,
  withPendingProposals,
  type ToolModule,
} from "@covel/tools";
import { z } from "zod";
import { registerNamespaced, type WireModuleShape } from "./plugin-wires.js";

/** Helper bag handed to entry factories — same surface the legacy
 *  `tools.local` factory injection provided, so migrated tool files keep
 *  their `({ tool, z, store, ... })` signature unchanged. */
export interface PluginToolkit {
  readonly tool: typeof tool;
  readonly z: typeof z;
  readonly shortId: typeof shortId;
  readonly shortIdBatch: typeof shortIdBatch;
  readonly withPendingProposals: typeof withPendingProposals;
  readonly store: DataStore;
}

export interface PluginHookOptions {
  /** Payload predicate — handler only fires when it returns true. */
  readonly match?: (payload: unknown) => boolean;
  readonly timeoutMs?: number;
  readonly enforce?: HookEnforce;
}

export interface PluginRpcOptions {
  readonly description?: string;
  readonly streaming?: boolean;
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

export interface BootstrapPluginEntriesParams {
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
  readonly toolMap: Map<string, ToolModule>;
  readonly localToolNames: Set<string>;
  /** Mutable — entry-registered tool names are added at invocation time
   *  (unlike legacy `tools.local`, names aren't derivable from the manifest). */
  readonly pluginToolAccess: Map<string, Set<string>>;
  readonly hookPipeline: HookPipeline;
  readonly rpcRegistry: PluginRpcRegistry;
}

export interface BootstrapPluginEntries {
  /** Deferred entry invocation — memoized per pluginId, safe to await repeatedly. */
  readonly ensurePluginEntry: (pluginId: string) => Promise<void>;
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
}: BootstrapPluginEntriesParams): Promise<BootstrapPluginEntries> {
  const toolkit: PluginToolkit = {
    tool,
    z,
    shortId,
    shortIdBatch,
    withPendingProposals,
    store,
  };
  const http = { fetchWithRetry, validateBaseUrl: validateBaseUrlForPlugin };

  warnLegacyRegistrationFields(manifestCache);

  const buildApi = (pluginId: string, pluginRelPath: string): PluginAPI => {
    let hookSeq = 0;
    const trustInfo = getPluginTrustInfo(
      pluginId,
      discoveryMap.get(pluginId)?.source,
    );
    const pluginTrust: RpcTrustLevel =
      trustInfo.source === "builtin"
        ? "builtin"
        : trustInfo.source === "community"
          ? "community"
          : "official";

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
        hookPipeline.register({
          id: `${pluginId}:${event}:entry#${hookSeq}`,
          event,
          pluginId,
          handler,
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
    const manifests = manifestCache.get(pluginId);
    if (!manifests) return;

    // Dedupe by declared path — multiple runtimes may (incorrectly) declare
    // the same entry; it runs once. Convention: declare on the root PLUGIN.md.
    const entryPaths = new Set<string>();
    for (const parsed of manifests) {
      if (parsed.manifest.entry) entryPaths.add(parsed.manifest.entry);
    }
    if (entryPaths.size === 0) return;

    const pluginRelPath = path.relative(
      process.cwd(),
      path.join(discovery.rootPath, "PLUGIN.md"),
    );
    const api = buildApi(pluginId, pluginRelPath);

    for (const entryPath of entryPaths) {
      const fullPath = path.resolve(discovery.rootPath, entryPath);
      try {
        const rel = path.relative(discovery.rootPath, fullPath);
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

  // builtin/official: run entries at bootstrap so their capabilities are
  // available from the first turn.
  for (const [pluginId, discovery] of discoveryMap) {
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (!trust.autoLoad) continue;
    await invokeEntryForPlugin(pluginId);
  }

  const invokedPluginIds = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();

  const ensurePluginEntry = async (pluginId: string): Promise<void> => {
    if (invokedPluginIds.has(pluginId)) return;
    const pending = inFlight.get(pluginId);
    if (pending) return pending;

    const discovery = discoveryMap.get(pluginId);
    if (!discovery) return;
    const trust = getPluginTrustInfo(pluginId, discovery.source);
    if (trust.autoLoad) {
      // Already handled in the bootstrap loop above.
      invokedPluginIds.add(pluginId);
      return;
    }

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

  return { ensurePluginEntry };
}

/** One warning per plugin still using the legacy registration fields. */
function warnLegacyRegistrationFields(
  manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>,
): void {
  for (const [pluginId, manifests] of manifestCache) {
    const legacy = new Set<string>();
    for (const parsed of manifests) {
      const m = parsed.manifest;
      if (m.tools?.local?.length) legacy.add("tools.local");
      if (m.hooks?.length) legacy.add("hooks");
      if (m.rpc && Object.keys(m.rpc).length > 0) legacy.add("rpc");
      if (m.wires) legacy.add("wires");
    }
    if (legacy.size === 0) continue;
    console.warn(
      `[plugin-entry] ${pluginId}: PLUGIN.md field(s) ${[...legacy].join(", ")} are deprecated — ` +
        `migrate to a single "entry" module (export default function (covel) { ... }). ` +
        `Legacy fields keep working for this release cycle.`,
    );
  }
}
