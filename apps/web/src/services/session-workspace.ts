import type { PluginRpcRequest, PluginRpcResponse } from "@covel/shared";
import { postPluginRpc as requestPluginRpc } from "./api/plugin-rpc.js";
import { runWorkspaceMutation } from "./workspace-coordinator.js";

/** Run plugin RPC and checkpoint its non-streaming session mutations. */
export function postPluginRpc(
  sessionId: string,
  request: PluginRpcRequest,
): Promise<PluginRpcResponse> {
  return runWorkspaceMutation(
    sessionId,
    `plugin-rpc:${crypto.randomUUID()}`,
    () => requestPluginRpc(sessionId, request),
  );
}
