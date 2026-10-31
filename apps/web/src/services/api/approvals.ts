import i18n from "@/i18n";
import { emitToast } from "@/lib/toast-channel";
import { ApiError, request } from "./request.js";

// -- Approvals (RPC approval gate) -------------------------------

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
    silentCodes: ["approval_obsolete"],
  }).catch((error: unknown) => {
    // The server consumed this request without a grant. Callers retry the
    // original enable/run against current policy, retaining their visit guards.
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === "approval_obsolete"
    )
      return undefined;
    throw error;
  });
  // The server loads the plugin's tasks as soon as its code may run. One that
  // does not load is said now, with the reason, not found by a later turn.
  const failures = result?.runtimeLoadErrors ?? [];
  if (failures.length > 0)
    emitToast(
      "error",
      i18n.t("pluginJob.runtimesNotLoaded", {
        plugin: result?.pending?.pluginId ?? "",
        count: failures.length,
        defaultValue:
          "{{plugin}} was approved, but {{count}} of its tasks cannot be loaded and will not run.",
      }),
      failures
        .map((failure) => `${failure.runtimeId}: ${failure.error}`)
        .join("\n"),
    );
}
