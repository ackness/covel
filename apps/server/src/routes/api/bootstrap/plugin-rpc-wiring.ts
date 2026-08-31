import { createRpcApprovalGate, type RpcApprovalGate } from "@covel/approval";
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  submitFormHandler,
  type PluginRpcRegistry,
  type RpcExecutor,
} from "@covel/runtime";

export interface BootstrapPluginRpc {
  readonly rpcRegistry: PluginRpcRegistry;
  readonly rpcExecutor: RpcExecutor;
  readonly rpcApprovalGate: RpcApprovalGate;
}

export function createBootstrapPluginRpc(): BootstrapPluginRpc {
  const rpcRegistry: PluginRpcRegistry = createPluginRpcRegistry();
  rpcRegistry.registerFrameworkDefault("submit-form", submitFormHandler, {
    description:
      "Persist player input submissions and fill the originating template message.",
  });
  rpcRegistry.registerFrameworkDefault(
    "slash-debug",
    async (_payload, context) => {
      const runtimes = context.environment?.activeRuntimes ?? [];
      const storyModels = runtimes
        .filter(
          (runtime) =>
            runtime.outputKind === "story" ||
            runtime.capabilities.includes("narrative"),
        )
        .map((runtime) => runtime.model?.resolved ?? runtime.model?.slot)
        .filter((model): model is string => Boolean(model));
      const english = context.locale?.toLowerCase().startsWith("en") === true;
      const modelSummary =
        [...new Set(storyModels)].join(", ") || (english ? "default" : "默认");
      return {
        ok: true,
        message: english
          ? `Debug context ready: ${runtimes.length} active runtime(s), story model ${modelSummary}.`
          : `调试上下文已就绪：${runtimes.length} 个活跃 runtime，story model 为 ${modelSummary}。`,
        data: context.environment,
        clientAction: { type: "open-debug" },
      };
    },
    { description: "Open the current session debug view with fresh context" },
  );

  const rpcExecutor: RpcExecutor = createRpcExecutor({ registry: rpcRegistry });

  // Pending approvals + session-cached pre-authorizations live in memory per
  // bootstrap instance; they do not survive a restart or cross processes.
  const rpcApprovalGate: RpcApprovalGate = createRpcApprovalGate();

  return { rpcRegistry, rpcExecutor, rpcApprovalGate };
}
