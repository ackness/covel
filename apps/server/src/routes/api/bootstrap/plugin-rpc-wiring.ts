import { createRpcApprovalGate, type RpcApprovalGate } from "@covel/approval";
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  createSubmitFormHandler,
  type PluginRpcRegistry,
  type RpcExecutor,
} from "@covel/runtime";
import { FrameworkCapability, isDefaultLocale } from "@covel/shared";

export interface BootstrapPluginRpc {
  readonly rpcRegistry: PluginRpcRegistry;
  readonly rpcExecutor: RpcExecutor;
  readonly rpcApprovalGate: RpcApprovalGate;
}

export function createBootstrapPluginRpc(): BootstrapPluginRpc {
  const rpcRegistry: PluginRpcRegistry = createPluginRpcRegistry();
  rpcRegistry.registerFrameworkDefault(
    "submit-form",
    createSubmitFormHandler(async (request) => {
      const validator = rpcRegistry.getFormValidator(
        request.pluginId,
        request.name,
      );
      if (!validator)
        throw new Error(
          "Form validator is unavailable; activate and approve its plugin first",
        );
      return validator(request);
    }),
    {
      description:
        "Persist player input submissions and fill the originating template message.",
    },
  );
  rpcRegistry.registerFrameworkDefault(
    "slash-debug",
    async (_payload, context) => {
      const runtimes = context.environment?.activeRuntimes ?? [];
      const storyModels = runtimes
        .filter(
          (runtime) =>
            runtime.outputKind === "story" ||
            runtime.capabilities.includes(FrameworkCapability.Narrative),
        )
        .map((runtime) => runtime.model?.resolved ?? runtime.model?.slot)
        .filter((model): model is string => Boolean(model));
      const chinese = isDefaultLocale(context.locale);
      const modelSummary =
        [...new Set(storyModels)].join(", ") || (chinese ? "默认" : "default");
      return {
        ok: true,
        message: chinese
          ? `调试上下文已就绪：${runtimes.length} 个活跃 runtime，story model 为 ${modelSummary}。`
          : `Debug context ready: ${runtimes.length} active runtime(s), story model ${modelSummary}.`,
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
