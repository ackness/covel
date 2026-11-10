/**
 * Bootstrap stage 5: run plugin server entries into the host from stage 4,
 * bind community activation to the trust and approval gates, start watching
 * plugin directories, and expose read-only diagnostics.
 *
 * Builtin entries run here; community entries defer to `ensurePluginEntry`
 * until the player approves their server code.
 */

import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import { refreshDeclarativeEligibility } from "../../../trust/plugin-admission.js";
import {
  conventionsOfPlugins,
  setWorldDataConventions,
} from "../../../world-data/conventions.js";
import type { UiSlotHost } from "../../../ui-slots/host.js";
import { createPluginDiagnostics } from "../plugin-diagnostics.js";
import { sessionApprovalScope } from "../session/session-guard.js";
import type { BootstrapOwned } from "./event-infrastructure.js";
import type { BootstrapPluginCatalog } from "./plugin-catalog.js";
import {
  createBootstrapPluginEntries,
  type BootstrapPluginEntries,
} from "./plugin-entry.js";
import type { BootstrapPluginHost } from "./plugin-host.js";
import type { RuntimeLoadFailure } from "./runtime-loader.js";
import type { TrustedSourcesRef } from "./server-trust.js";
import type { BootstrapStorage } from "./storage.js";

/** Run `fn` against one session's frozen plugin snapshot and service authority. */
export type WithPluginSnapshot = <T>(
  sessionId: string,
  fn: () => Promise<T>,
  beforeCapture?: () => Promise<void>,
) => Promise<T>;

export interface BootstrapPluginActivation {
  readonly pluginEntries: BootstrapPluginEntries;
  readonly activatePluginServerCode: (
    pluginId: string,
    sessionId?: string,
  ) => Promise<void>;
  readonly withPluginSnapshot: WithPluginSnapshot;
  readonly pluginDiagnostics: ReturnType<typeof createPluginDiagnostics>;
  readonly preloadPluginRuntimes: (
    pluginId: string,
    sessionId: string,
  ) => Promise<readonly RuntimeLoadFailure[]>;
}

export async function activatePluginEntries(args: {
  readonly storage: BootstrapStorage;
  readonly catalog: BootstrapPluginCatalog;
  readonly host: BootstrapPluginHost;
  readonly trust: TrustedSourcesRef;
  readonly owned: BootstrapOwned;
  /**
   * The UI slot host, built after this stage. A reload invalidates its
   * session projections; reloads only start once `watch()` has run and the
   * stages up to the slot host are synchronous, so it exists by then.
   */
  readonly uiSlots: () => UiSlotHost;
}): Promise<BootstrapPluginActivation> {
  const { storage, catalog, host, trust, owned } = args;
  const { store, sessionLock } = storage;
  const { registry } = catalog;
  const { runtimeLoader, serviceAdmission } = host;
  const { rpcApprovalGate } = host.rpc;

  // Entry import only honors the EXACT server-code grant. The old
  // no-action `hasGrant` matched any live grant for the plugin, so approving
  // one ordinary RPC action (or one runtime) silently authorized importing
  // and executing the plugin's entire server entry.
  const isCommunityServerCodeApproved = async (
    sessionId: string | undefined,
    pluginId: string,
  ): Promise<boolean> => {
    if (!sessionId) return false;
    await trust.current?.ensureFresh(pluginId);
    const session = await store.getSession(sessionId);
    return Boolean(
      session &&
      rpcApprovalGate.hasGrant(
        sessionId,
        pluginId,
        COMMUNITY_SERVER_CODE_ACTION,
        sessionApprovalScope(session, pluginId),
      ),
    );
  };
  const isCommunityHookApproved = async (
    sessionId: string,
    pluginId: string,
  ): Promise<boolean> => {
    await trust.current?.ensureFresh(pluginId);
    const session = await store.getSession(sessionId);
    return Boolean(
      session &&
      rpcApprovalGate.hasGrant(
        sessionId,
        pluginId,
        COMMUNITY_SERVER_CODE_ACTION,
        sessionApprovalScope(session, pluginId),
      ),
    );
  };

  // Unified plugin server entries (`entry` frontmatter field) — needs the
  // tool map, hook pipeline, and rpc registry from the plugin host.
  const pluginEntries = (owned.pluginEntries =
    await createBootstrapPluginEntries({
      sessionLock,
      discoveryMap: catalog.discoveryMap,
      failedDiscoveryMap: catalog.failedDiscoveryMap,
      manifestCache: catalog.manifestCache,
      pluginRegistry: registry,
      store,
      tools: host.tools.tools,
      hookPipeline: host.hookPipeline,
      rpcRegistry: host.rpc.rpcRegistry,
      isCommunityServerCodeApproved,
      isDeclarativePackage: (pluginId) =>
        refreshDeclarativeEligibility(trust.current, pluginId),
      isCommunityHookApproved,
      runtimeLoader,
      prepareDeclarations: catalog.prepareEventDeclarations,
      onReload: async () => {
        setWorldDataConventions(conventionsOfPlugins(registry));
        for (const session of await store.listSessions())
          args.uiSlots().invalidateSession(session.id);
      },
      services: host.services,
      extensions: host.extensions,
    }));
  // Community activation seam: running the plugin's `entry` module is what
  // registers its tools, hooks, rpc actions and wires.
  const activatePluginServerCode = async (
    pluginId: string,
    sessionId?: string,
  ): Promise<void> => {
    await trust.current?.ensureFresh(pluginId);
    await pluginEntries.ensurePluginEntry(pluginId, sessionId);
    // Publishing an entry re-registers it and invalidates its verification.
    await trust.current?.ensureFresh(pluginId);
  };
  runtimeLoader.bindPluginEntry(activatePluginServerCode);
  const withPluginSnapshot: WithPluginSnapshot = <T>(
    sessionId: string,
    fn: () => Promise<T>,
    beforeCapture?: () => Promise<void>,
  ): Promise<T> => {
    let authority: Awaited<ReturnType<typeof serviceAdmission.capture>>;
    return pluginEntries.withSnapshot(
      sessionId,
      () => authority.run(fn),
      async () => {
        await beforeCapture?.();
        authority = await serviceAdmission.capture(sessionId);
      },
    );
  };
  pluginEntries.watch();
  const pluginDiagnostics = createPluginDiagnostics({
    getTrustedSources: () => trust.current,
    registry,
    tools: host.tools.tools,
    hooks: host.hookPipeline,
    rpc: host.rpc.rpcRegistry,
    services: host.services,
    extensions: host.extensions,
    calls: host.serviceCalls,
    isEntryPublished: pluginEntries.isEntryPublished,
    isServerCodeApproved: (session, pluginId) =>
      rpcApprovalGate.hasGrant(
        session.id,
        pluginId,
        COMMUNITY_SERVER_CODE_ACTION,
        sessionApprovalScope(session, pluginId),
      ),
  });

  // For the routes that take the player's approval: the plugin's runtimes are
  // loaded right then, and one that does not import is in their answer.
  const preloadPluginRuntimes = async (pluginId: string, sessionId: string) => {
    const failures = await runtimeLoader.preload(pluginId, sessionId);
    for (const failure of failures)
      console.error(
        `[bootstrap] runtime ${failure.runtimeId} of plugin ${pluginId} does not load: ${failure.error}`,
      );
    return failures;
  };

  return {
    pluginEntries,
    activatePluginServerCode,
    withPluginSnapshot,
    pluginDiagnostics,
    preloadPluginRuntimes,
  };
}
