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

  const rpcExecutor: RpcExecutor = createRpcExecutor({ registry: rpcRegistry });

  // Pending approvals + session-cached pre-authorizations live in memory per
  // bootstrap instance; they do not survive a restart or cross processes.
  const rpcApprovalGate: RpcApprovalGate = createRpcApprovalGate();

  return { rpcRegistry, rpcExecutor, rpcApprovalGate };
}
