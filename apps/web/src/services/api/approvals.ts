import { request } from "./request.js";

// -- Approvals (RPC approval gate) -------------------------------

export interface ApprovalRecord {
  approvalId: string;
  sessionId: string;
  action: string;
  pluginId: string;
  payload: unknown;
  trustLevel: "builtin" | "official" | "community";
  description?: string;
  requestedAt: string;
}

export async function listApprovals(
  sessionId: string,
): Promise<ApprovalRecord[]> {
  const res = await request<{ pending: ApprovalRecord[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/approvals`,
  );
  return res.pending;
}

export async function resolveApproval(
  approvalId: string,
  decision: "allow" | "deny",
  scope?: "once" | "session",
): Promise<void> {
  await request(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, scope }),
  });
}
