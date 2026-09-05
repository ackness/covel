import { request } from "./request.js";
import type { PluginRpcRequest, PluginRpcResponse } from "./types.js";

// -- Plugin RPC -------------------------------------------------
//
// The server accepts three explicitly discriminated dispatch modes:
//
//   Action-level:  { kind: "action", pluginId, action, payload }
//   Runtime-level: { kind: "runtime", pluginId, runtimeId, payload }
//   Command-level: { kind: "command", commandId, input | args }
//
// Responses carry a `status` discriminator:
//   - 'ok'                - sync result or action-level completion
//   - 'accepted'          - background runtime queued; poll _jobs/{jobId}
//                           via plugin-data.changed SSE
//   - 'approval-required' - community plugin needs user approval
// Non-2xx failures use the shared ApiError response and are thrown by request().

export async function postPluginRpc(
  sessionId: string,
  req: PluginRpcRequest,
): Promise<PluginRpcResponse> {
  return request<PluginRpcResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugin-rpc`,
    { method: "POST", body: JSON.stringify(req), operatorAuth: true },
  );
}
