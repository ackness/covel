import { resolve } from "node:path";
import { createPluginManager, type PluginManager } from "@covel/plugin-manager";
import { createV1KernelSession, type V1KernelSession } from "@covel/kernel";
import { createApprovalService, createServiceGateway, createToolGatewayService, type ApprovalService, type TraceService, type ToolGatewayService } from "@covel/services";
import type { AiStack } from "./ai-setup.js";
import { createRuntimeGatewayResolver, createV1RuntimeExecutor } from "./v1-runtime-executor.js";

export interface V1KernelStack {
  pluginManager: PluginManager;
  getOrCreateSession(sessionId: string): V1KernelSession;
  removeSession(sessionId: string): void;
}

export async function initV1KernelStack(aiStack: AiStack): Promise<V1KernelStack> {
  const pluginManager = createPluginManager();
  const v1PluginsDir = process.env.COVEL_V1_PLUGINS_DIR ?? resolve(import.meta.dirname, "../../../docs/plugin-system-v1");
  await pluginManager.loadAll(v1PluginsDir);

  const whitelistedPlugins = new Set(
    pluginManager.list()
      .filter((plugin) => plugin.pluginType === "core-plugin")
      .map((plugin) => plugin.id),
  );
  const resolveGatewayForRuntime = createRuntimeGatewayResolver();

  const sessions = new Map<string, V1KernelSession>();

  function getOrCreateSession(sessionId: string): V1KernelSession {
    const existing = sessions.get(sessionId);
    if (existing) return existing;

    const services = createServiceGateway({
      whitelistedPlugins,
    });
    services.tools = createToolGatewayService({
      registry: pluginManager.registries.tools,
      approvals: services.approvals,
      trace: services.traceStore,
    });

    const created = createV1KernelSession({
      pluginManager,
      approvalService: services.approvals,
      executeRuntime: createV1RuntimeExecutor({
        services,
        resolveGatewayForRuntime,
      }),
    }, sessionId);
    sessions.set(sessionId, created);
    return created;
  }

  function removeSession(sessionId: string): void {
    sessions.delete(sessionId);
  }

  return {
    pluginManager,
    getOrCreateSession,
    removeSession,
  };
}
