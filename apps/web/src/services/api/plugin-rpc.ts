import { request } from "./request.js";
import type { PluginRpcRequest, PluginRpcResponse } from "./types.js";

// -- Plugin RPC -------------------------------------------------
//
// The server accepts two mutually exclusive dispatch modes:
//
//   Action-level:  { pluginId, action, payload }
//   Runtime-level: { pluginId, runtimeId, payload }
//
// Responses carry a `status` discriminator:
//   - 'ok'                - sync result or action-level completion
//   - 'accepted'          - background runtime queued; poll _jobs/{jobId}
//                           via plugin-data.changed SSE
//   - 'approval-required' - community plugin needs user approval
//   - 'error'             - dispatch or execution failure

export async function postPluginRpc(
  sessionId: string,
  req: PluginRpcRequest,
): Promise<PluginRpcResponse> {
  return request<PluginRpcResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugin-rpc`,
    { method: "POST", body: JSON.stringify(req), operatorAuth: true },
  );
}
