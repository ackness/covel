import i18n from "@/i18n";
import { emitToast } from "@/lib/toast-channel";
import { request } from "./request.js";

// -- Approvals (RPC approval gate) -------------------------------

export interface ApprovalRecord {
  approvalId: string;
  sessionId: string;
  action: string;
  pluginId: string;
  payload: unknown;
  trustLevel: "builtin" | "community";
  description?: string;
  requestedAt: string;
}

export async function listApprovals(
  sessionId: string,
): Promise<ApprovalRecord[]> {
  const res = await request<{ items: ApprovalRecord[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/approvals`,
  );
  return res.items;
}

export async function resolveApproval(
  approvalId: string,
  decision: "allow" | "deny",
  scope?: "once" | "session",
  sessionId?: string,
): Promise<void> {
  const result = await request<{
    pending?: { pluginId?: string };
    runtimeLoadErrors?: { runtimeId: string; error: string }[];
  }>(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, scope }),
    sessionId,
    operatorAuth: true,
  });
  // The server loads the plugin's tasks as soon as its code may run. One that
  // does not load is said now, with the reason, not found by a later turn.
  const failures = result?.runtimeLoadErrors ?? [];
  if (failures.length > 0)
    emitToast(
      "error",
      i18n.t("pluginJob.runtimesNotLoaded", {
        plugin: result.pending?.pluginId ?? "",
        count: failures.length,
        defaultValue:
          "{{plugin}} was approved, but {{count}} of its tasks cannot be loaded and will not run.",
      }),
      failures
        .map((failure) => `${failure.runtimeId}: ${failure.error}`)
        .join("\n"),
    );
}
