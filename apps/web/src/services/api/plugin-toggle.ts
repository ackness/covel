import i18n from "@/i18n";
import { emitToast } from "@/lib/toast-channel.js";
import { ApiError, request, type RequestOptions } from "./request.js";

const ERROR_KEYS: Readonly<Record<string, string>> = {
  dimension_provider_conflict: "dimensionProviderConflict",
  dimension_provider_required: "dimensionProviderRequired",
  plugin_not_found: "pluginNotFound",
  "unknown-plugin": "pluginNotFound",
  approval_queue_full: "approvalQueueFull",
  approval_scope_changed: "approvalScopeChanged",
  "approval-required": "approvalRequired",
  session_incarnation_changed: "sessionChanged",
  session_deleting: "sessionDeleting",
  session_not_active: "sessionNotActive",
  session_busy: "sessionBusy",
  session_not_found: "sessionNotFound",
  excluded: "excluded",
  "missing-provider": "missingProvider",
  "ambiguous-provider": "ambiguousProvider",
  conflict: "conflict",
  "single-provider-conflict": "conflict",
  "event-topic-conflict": "conflict",
  "default-replaced": "defaultReplaced",
  "invalid-conflict": "invalidConflict",
  operator_token_required: "operatorRequired",
  session_owner_required: "sessionOwnerRequired",
  desktop_rest_token_invalid: "desktopTokenInvalid",
};

/** One localized toast for a failed toggle, retaining the server diagnostics. */
export async function requestPluginToggle<T>(
  url: string,
  options: RequestOptions,
): Promise<T> {
  try {
    return await request<T>(url, { ...options, silentErrors: true });
  } catch (error) {
    const key =
      error instanceof ApiError &&
      error.code &&
      Object.hasOwn(ERROR_KEYS, error.code)
        ? (ERROR_KEYS[error.code] ?? "generic")
        : "generic";
    const detail =
      error instanceof ApiError
        ? `${error.status} ${error.url}\n${error.body}`
        : `${url}\n${error instanceof Error ? error.message : String(error)}`;
    emitToast("error", i18n.t(`plugin.toggleError.${key}`), detail);
    throw error;
  }
}
