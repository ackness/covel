/**
 * Boot-time runtime loader with the community dual-authorization gate.
 *
 * Extracted verbatim from `assembleApi` so the last inline block of the
 * bootstrap dependency graph lives in its own module. Behavior is unchanged:
 * fail-closed community gating (missing sessionId/session throws; either
 * grant missing throws) and the late-bound `ensurePluginEntry` seam.
 *
 * ORDERING CONSTRAINT (current shape):
 * - `loadRuntimeFn` has NO boot-time caller. The only runtime load entry
 *   points are the injected request path (`c.get("loadRuntimeFn")` in route
 *   handlers) and the detached runtime job worker — both are wired in
 *   `assembleApi` after `bindPluginEntry` has replaced the no-op seam.
 * - The loader forward-references two things built later in `assembleApi`:
 *   the rpc approval gate (resolved lazily through `getApprovalGate` at call
 *   time) and the real `ensurePluginEntry` (assigned through
 *   `bindPluginEntry` right after `createBootstrapPluginEntries` resolves).
 *   Until the seam is bound, `ensurePluginEntry` is a no-op, so an early call
 *   can never import community entry code; a community runtime without a
 *   live approved session fails closed at the dual-grant gate below.
 */

import type { RuntimeManifest } from "@covel/shared";
import {
  loadRuntime as loadRuntimeFromDisk,
  getPluginTrustInfo,
  type PluginRegistry,
  type ParsedPluginMd,
  type PluginDiscoveryResult,
  type LoadedRuntime,
} from "@covel/plugin-loader";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  type RpcApprovalGate,
} from "@covel/approval";
import type { DataStore } from "@covel/store";
import { sessionApprovalScope } from "../session/session-guard.js";

export interface RuntimeLoaderParams {
  readonly pluginRegistry?: PluginRegistry;
  readonly discoveryMap: ReadonlyMap<string, PluginDiscoveryResult>;
  readonly manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>;
  readonly store: DataStore;
  /**
   * The approval gate is constructed after this loader (tool wiring sits
   * between), so it is resolved lazily at call time. Every legitimate caller
   * runs after the gate exists; see the ORDERING CONSTRAINT above.
   */
  readonly getApprovalGate: () => RpcApprovalGate;
}

export interface RuntimeLoader {
  /** loadRuntime resolver (locale-aware: loads PLUGIN.en.md when locale is "en-US"). */
  readonly loadRuntimeFn: (
    manifest: RuntimeManifest,
    locale?: string,
    sessionId?: string,
  ) => Promise<LoadedRuntime | undefined>;
  /**
   * Late-bound entry seam. Stays a no-op until `bindPluginEntry` assigns the
   * real `ensurePluginEntry` from `createBootstrapPluginEntries`.
   */
  ensurePluginEntry(pluginId: string, sessionId?: string): Promise<void>;
  bindPluginEntry(
    fn: (pluginId: string, sessionId?: string) => Promise<void>,
  ): void;
}

export function createRuntimeLoader(
  params: RuntimeLoaderParams,
): RuntimeLoader {
  const { discoveryMap, manifestCache, store, getApprovalGate } = params;

  let boundEnsurePluginEntry: (
    pluginId: string,
    sessionId?: string,
  ) => Promise<void> = async () => {};

  const loadRuntimeFn = async (
    manifest: RuntimeManifest,
    locale?: string,
    sessionId?: string,
  ): Promise<LoadedRuntime | undefined> => {
    for (const [pluginId, discovery] of discoveryMap) {
      const manifests = manifestCache.get(pluginId);
      if (manifests?.some((m) => m.manifest.name === manifest.name)) {
        const trust = getPluginTrustInfo(pluginId, discovery.source);
        // Loading a community runtime executes the plugin's server
        // code (entry / handler import) AND runs that specific runtime, so
        // BOTH grants are required — the exact server-code grant and the
        // exact `runtime:<name>` grant. The old OR let a single runtime
        // approval unlock the whole plugin's server code (and vice versa),
        // collapsing the two-phase consent the UI presents.
        if (!trust.autoLoad) {
          const approvalSession = sessionId
            ? await store.getSession(sessionId)
            : undefined;
          if (!sessionId || !approvalSession) {
            throw new Error(
              `[runtime-loader] ${pluginId}/${manifest.name}: community runtime requires a live session approval scope`,
            );
          }
          const approvalScope = sessionApprovalScope(approvalSession, pluginId);
          const approvalGate = getApprovalGate();
          if (
            !approvalGate.hasGrant(
              sessionId,
              pluginId,
              COMMUNITY_SERVER_CODE_ACTION,
              approvalScope,
            ) ||
            !approvalGate.hasGrant(
              sessionId,
              pluginId,
              `runtime:${manifest.name}`,
              approvalScope,
            )
          ) {
            throw new Error(
              `[runtime-loader] ${pluginId}/${manifest.name}: community runtime requires explicit session approval (server-code AND runtime grants)`,
            );
          }
        }
        // The entry check is the fail-closed approval boundary. Keep it ahead
        // of every other community import, including the runtime handler.
        await boundEnsurePluginEntry(pluginId, sessionId);
        const entry = params.pluginRegistry?.get(pluginId);
        return loadRuntimeFromDisk(discovery, manifest.name, locale, {
          packageManifest: entry?.packageManifest,
          manifests,
        });
      }
    }
    return undefined;
  };

  return {
    loadRuntimeFn,
    ensurePluginEntry: (pluginId, sessionId) =>
      boundEnsurePluginEntry(pluginId, sessionId),
    bindPluginEntry: (fn) => {
      boundEnsurePluginEntry = fn;
    },
  };
}
