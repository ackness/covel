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
  parsePluginMd,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
} from "@covel/plugin-loader";
import {
  activateDeferredPluginHooks,
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
  /** Mutable — entry-registered tool names are added at invocation time
   *  (unlike legacy `tools.local`, names aren't derivable from the manifest). */
  readonly pluginToolAccess: Map<string, Set<string>>;
  readonly hookPipeline: HookPipeline;
  readonly rpcRegistry: PluginRpcRegistry;
  /** Fail-closed session authorization for community server code. */
  readonly isCommunityServerCodeApproved?: (
    sessionId: string | undefined,
    pluginId: string,
  ) => boolean;
  /** Narrower grant used for lifecycle hook execution after import. */
  readonly isCommunityHookApproved?: (
    sessionId: string,
    pluginId: string,
  ) => boolean;
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

    // Community entries get a pluginId-scoped store view; builtin/official
    // keep the raw store (parity with the legacy tools.local factory).
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
            !isCommunityHookApproved?.(ctx.sessionId, pluginId)
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
    const manifests = manifestCache.get(pluginId);
    if (!manifests) return;

    // Dedupe by declared path — multiple runtimes may (incorrectly) declare
    // the same entry; it runs once. Convention: declare on the root PLUGIN.md.
    const entryPaths = new Set<string>();
    for (const parsed of manifests) {
      if (parsed.manifest.entry) entryPaths.add(parsed.manifest.entry);
    }
    // For a MULTI-runtime plugin, the metadata-only root PLUGIN.md is excluded
    // from `manifests` (discover.ts lists only runtime PLUGIN.mds), so an
    // `entry` declared there — the documented convention — is otherwise dropped
    // and the plugin's local tools never register (found: npc-graph's graph
    // tools were silently absent from the extractor's LLM tool list). Read the
    // root directly; the Set dedupes the single-runtime overlap.
    const rootMdPath = path.join(discovery.rootPath, "PLUGIN.md");
    if (fsSync.existsSync(rootMdPath)) {
      try {
        const rootEntry = parsePluginMd(
          fsSync.readFileSync(rootMdPath, "utf8"),
          rootMdPath,
        ).manifest.entry;
        if (rootEntry) entryPaths.add(rootEntry);
      } catch (err) {
        // Non-fatal — the runtime manifests still drive entry resolution —
        // but a broken root PLUGIN.md would silently drop a declared entry
        // (the exact failure mode this read exists to prevent), so log it.
        console.warn(
          `[plugin-entry] ${pluginId}: failed to parse root PLUGIN.md for entry —`,
          err instanceof Error ? err.message : err,
        );
      }
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

  // KNOWN LIMITATION (community entry hooks miss early events).
  //
  // Legacy `hooks` register their declarations at boot for every trust tier
  // (handlers lazy-load on first fire — community handlers stay dormant until
  // `activateDeferredPluginHooks` below), so builtin/official legacy
  // hooks catch SessionStart / TurnStart from turn one. Entry hooks only
  // enter the HookPipeline once `ensurePluginEntry` has run. For a community
  // plugin the earliest that either fires is at APPROVAL (`approvals.ts`
  // `allow` → activatePluginServerCode) or first runtime schedule / rpc
  // activation — never before approval, by design (unapproved third-party
  // code must not run at boot). Consequences:
  //   - events that fire before the activation point in the approving turn
  //     (e.g. this session's SessionStart) are missed by the entry's hooks;
  //   - every process restart re-opens the window for an already-approved
  //     community plugin until it is next activated.
  // We do NOT close this by reviving declarative hook manifests — that would
  // trade the single-entry model for the very split it replaced. builtin /
  // official entries ran in the boot loop above and are unaffected.
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
    if (!isCommunityServerCodeApproved?.(sessionId, pluginId)) {
      throw new Error(
        `[plugin-entry] ${pluginId}: community server code requires explicit approval for session ${sessionId ?? "<missing>"}`,
      );
    }
    if (invokedPluginIds.has(pluginId)) return;
    const pending = inFlight.get(pluginId);
    if (pending) return pending;

    const promise = (async () => {
      try {
        // Approval also unlocks the plugin's legacy `hooks:` handlers,
        // which were registered dormant at boot (plugin-hooks.ts). Activate
        // BEFORE the entry runs, and regardless of whether the plugin
        // declares an `entry` at all — a legacy-hooks-only community plugin
        // reaches this seam through the same approval path.
        activateDeferredPluginHooks(hookPipeline, pluginId);
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
    // builtin/official entries ran at boot, so a miss is a genuine 404.
    if (getPluginTrustInfo(pluginId, discovery.source).autoLoad) return false;
    const manifests = manifestCache.get(pluginId);
    if (!manifests) return false;
    return manifests.some((parsed) => Boolean(parsed.manifest.entry));
  };

  return { ensurePluginEntry, hasPendingEntry };
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
        `Legacy fields are planned for removal in v0.0.17.`,
    );
  }
}
