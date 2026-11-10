/**
 * Bootstrap stage 9: the Hono app — request ownership, error handling,
 * per-request dependency injection, request-scoped LLM overrides, and every
 * `/api` route except server settings, which the trust stage mounts once
 * settings are loaded.
 */

import { Hono } from "hono";
import type { MemorySystem } from "@covel/memory";
import type { EventBus } from "@covel/events";
import { makeErrorHandler } from "../../../api-error.js";
import {
  createApplicationWork,
  type ApplicationWork,
} from "../../../application-work.js";
import type { UiSlotHost } from "../../../ui-slots/host.js";
import { actionRoutes } from "../actions.js";
import { aiRoutes } from "../ai.js";
import { approvalRoutes, sessionApprovalRoutes } from "../approvals.js";
import {
  createBrowserWorkspaceCache,
  createBrowserWorkspaceRoutes,
} from "../browser-workspace.js";
import { characterRoutes } from "../characters.js";
import { eventRoutes } from "../events.js";
import { frameworkRoutes } from "../framework.js";
import { createHealthRoutes } from "../health.js";
import { installRoutes } from "../install.js";
import { lorebookRoutes } from "../lorebook.js";
import { mediaImageFlowRoutes } from "../media-image-flow.js";
import { mediaRoutes } from "../media.js";
import { messageRoutes } from "../messages.js";
import { pluginDataRoutes } from "../plugin-data.js";
import { createPluginReloadRoutes } from "../plugin-reload.js";
import { pluginRpcRoutes } from "../plugin-rpc.js";
import { pluginRoutes } from "../plugins.js";
import { resumeRoutes } from "../resume.js";
import { runtimeJobRoutes } from "../runtime-jobs.js";
import { runtimeOutputRoutes } from "../runtime-outputs.js";
import { verifyResolvedSessionRead } from "../session/session-guard.js";
import { sessionTurnRoutes } from "../session-turns.js";
import { sessionRoutes } from "../session.js";
import { setupRuntimeControlRoutes } from "../setup-runtime-control.js";
import { snapshotRoutes } from "../snapshots.js";
import { stateRoutes } from "../state.js";
import { subscribeRoutes } from "../subscribe.js";
import { traceRoutes } from "../traces.js";
import { turnControlRoutes } from "../turn-control-routes.js";
import { uiSlotRoutes } from "../ui-slots.js";
import { worldRoutes } from "../worlds.js";
import type { ApiBootstrapConfig } from "./config.js";
import type { BootstrapModelContext } from "./model-context.js";
import type { BootstrapPluginActivation } from "./plugin-activation.js";
import type { BootstrapPluginCatalog } from "./plugin-catalog.js";
import type { BootstrapPluginHost } from "./plugin-host.js";
import { requestLlmServices } from "./request-llm-services.js";
import type { BootstrapRuntimeJobs } from "./runtime-jobs.js";
import type { TrustedSourcesRef } from "./server-trust.js";
import type { BootstrapStorage } from "./storage.js";

export interface BootstrapApiApp {
  readonly app: Hono;
  readonly applicationWork: ApplicationWork;
}

export function mountApiRoutes(args: {
  readonly config: ApiBootstrapConfig;
  readonly storage: BootstrapStorage;
  readonly eventBus: EventBus;
  readonly catalog: BootstrapPluginCatalog;
  readonly host: BootstrapPluginHost;
  readonly activation: BootstrapPluginActivation;
  readonly model: BootstrapModelContext;
  readonly memorySystem: MemorySystem;
  readonly jobs: BootstrapRuntimeJobs;
  readonly uiSlots: UiSlotHost;
  /** Read per request: the trust stage fills it before any request arrives. */
  readonly trust: TrustedSourcesRef;
}): BootstrapApiApp {
  const { config, storage, eventBus, catalog, host, activation, model } = args;
  const { jobs, uiSlots, trust, memorySystem } = args;
  const { store, sessionLock, memoryIngestLock } = storage;
  const { registry } = catalog;
  const { tools, rpc, services, extensions } = host;
  const { pluginEntries } = activation;
  const { runtimeEnv, compactionFailures, budgetSource } = model;

  const app = new Hono();
  const applicationWork = config.applicationWork ?? createApplicationWork();
  app.use("*", applicationWork.middleware);
  const browserWorkspaceCache = createBrowserWorkspaceCache();

  const isDev = runtimeEnv.nodeEnv !== "production";
  app.onError(makeErrorHandler("[api] Route error", isDev));

  app.use("*", async (c, next) => {
    if (config.hostProfile) c.set("hostProfile", config.hostProfile);
    c.set("store", store);
    c.set("storeBackend", config.storeBackend);
    c.set("eventBus", eventBus);
    c.set("pluginRegistry", registry);
    c.set("pluginServices", services);
    c.set("pluginExtensions", extensions);
    c.set("uiSlots", uiSlots);
    c.set("llmAdapter", config.llmAdapter);
    if (config.pluginGateway) {
      c.set("pluginGateway", config.pluginGateway);
    }
    if (config.pluginUtils) {
      c.set("pluginUtils", config.pluginUtils);
    }
    c.set("loadRuntimeFn", host.loadRuntimeFn);
    c.set("toolExecutor", tools.toolExecutor);
    c.set("resolveModel", model.resolveModel);
    c.set("compactorRunner", model.compactorRunner);
    c.set("turnContextBudget", model.turnContextBudget);
    c.set("hookPipeline", host.hookPipeline);
    c.set("pluginFaults", host.pluginFaults);
    c.set("eventDirectory", catalog.eventDirectory);
    c.set("memorySystem", memorySystem);
    c.set("rpcExecutor", rpc.rpcExecutor);
    c.set("rpcRegistry", rpc.rpcRegistry);
    c.set("rpcApprovalGate", rpc.rpcApprovalGate);
    c.set("trustedSources", trust.current);
    c.set("sessionLock", sessionLock);
    c.set("memoryIngestLock", memoryIngestLock);
    c.set("runtimeJobWorker", jobs.runtimeJobWorker);
    c.set("runtimeJobCredentials", jobs.runtimeJobCredentials);
    c.set("settledSessionLock", jobs.settledSessionLock);
    c.set("prepareToolsForSession", tools.prepareToolsForSession);
    c.set("clearSessionToolOverrides", tools.clearSessionToolOverrides);
    c.set("clearCompactionFailures", (id: string) =>
      compactionFailures.reset(id),
    );
    c.set("clearBrowserWorkspace", browserWorkspaceCache.clearSession);
    c.set("activatePluginServerCode", activation.activatePluginServerCode);
    c.set("preloadPluginRuntimes", activation.preloadPluginRuntimes);
    c.set("hasPendingPluginEntry", pluginEntries.hasPendingEntry);
    c.set("isPluginEntryPublished", pluginEntries.isEntryPublished);
    c.set("withPluginSnapshot", activation.withPluginSnapshot);
    c.set("reservedPluginIds", catalog.reservedPluginIds);
    if (config.worldsDirs) {
      c.set("worldsDirs", config.worldsDirs);
    }
    if (config.covelHome) {
      c.set("covelHome", config.covelHome);
    }
    if (config.vectorBackend !== "none" && config.ensureEmbeddingLock) {
      c.set("ensureEmbeddingLock", config.ensureEmbeddingLock);
    }
    if (config.vectorBackend !== "none" && config.memoryIndex) {
      c.set("memoryIndex", config.memoryIndex);
    }
    if (config.mediaStore) {
      c.set("mediaStore", config.mediaStore);
    }
    c.set("builtinToolNames", [...tools.tools.builtinTools.keys()].sort());
    await next();
    const staleRead = await verifyResolvedSessionRead(c);
    if (staleRead) c.res = staleRead;
  });

  // Apply request overrides after base dependency injection, then rebind services.
  for (const mw of config.perRequestMiddleware ?? []) app.use("*", mw);
  app.use(
    "*",
    requestLlmServices({
      extensions,
      store,
      failures: compactionFailures,
      ...budgetSource,
    }),
  );

  // Mount routes — all under /api/ prefix.
  // Session routes: frontend uses /api/sessions (plural) for all session operations
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/sessions", stateRoutes);
  app.route("/api/sessions", messageRoutes);
  app.route("/api/sessions", characterRoutes);
  app.route("/api/sessions", pluginDataRoutes);
  app.route("/api/sessions", uiSlotRoutes);
  app.route("/api/sessions", mediaImageFlowRoutes);
  app.route("/api/sessions", resumeRoutes); // suspend/resume (resume + suspensions list/delete)
  app.route("/api/sessions", snapshotRoutes); // state snapshots + fork
  app.route("/api/sessions", lorebookRoutes); // session-level lorebook viewer
  app.route("/api/sessions", runtimeOutputRoutes); // translation-layer observability
  app.route("/api/sessions", runtimeJobRoutes); // scheduler-detached runtime jobs
  app.route("/api/sessions", pluginRpcRoutes); // plugin RPC channel
  app.route("/api/sessions", turnControlRoutes); // mid-turn steer / abort
  app.route("/api/sessions", sessionTurnRoutes); // turn_results artifact listing
  app.route("/api/sessions", setupRuntimeControlRoutes); // setup retry / waive
  app.route("/api/sessions", sessionApprovalRoutes); // per-session approvals listing
  app.route(
    "/api/sessions",
    createBrowserWorkspaceRoutes(browserWorkspaceCache),
  );
  app.route("/api/approvals", approvalRoutes); // approval lookup + decision
  app.route("/api/plugins", createPluginReloadRoutes(pluginEntries));
  app.route("/api/plugins", pluginRoutes);
  app.route("/api/framework", frameworkRoutes);
  app.route("/api/events", eventRoutes);
  app.route("/api/events", subscribeRoutes);
  app.route("/api/worlds", worldRoutes);
  app.route(
    "/api/health",
    createHealthRoutes(store, config.storeBackend, {
      mediaBackend: config.mediaBackend,
      mediaStore: config.mediaStore,
      vectorBackend: config.vectorBackend,
      source: {
        repository: runtimeEnv.sourceRepository,
        commit: runtimeEnv.sourceCommit,
      },
    }),
  );
  app.route("/api/install", installRoutes);
  app.route("/api/ai", aiRoutes);
  app.route("/api/actions", actionRoutes);
  app.route("/api/traces", traceRoutes);
  app.route("/api/sessions", activation.pluginDiagnostics.routes);
  app.route("/api/media", mediaRoutes); // SPEC §5.1 (g): signed-URL access to MediaStore

  return { app, applicationWork };
}
