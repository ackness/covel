import { isLocaleMap } from "@covel/shared";
import i18n from "@/i18n";
import { resolveDisplayText } from "@/lib/i18n-text.js";
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

/** The plugin a refusal names in its `details`, in the interface language. */
function namedPlugin(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const { pluginId, displayName } = details as Record<string, unknown>;
  const name =
    typeof displayName === "string" || isLocaleMap(displayName)
      ? resolveDisplayText(displayName)
      : "";
  return name || (typeof pluginId === "string" ? pluginId : undefined);
}

/**
 * One localized toast for a failed toggle. A refusal the client knows needs
 * nothing more; an unexpected failure keeps the server's response as the
 * detail to copy.
 */
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
        ? ERROR_KEYS[error.code]
        : undefined;
    if (key) {
      const plugin =
        error instanceof ApiError ? namedPlugin(error.details) : undefined;
      emitToast(
        "error",
        plugin && i18n.exists(`plugin.toggleError.${key}Named`)
          ? i18n.t(`plugin.toggleError.${key}Named`, { plugin })
          : i18n.t(`plugin.toggleError.${key}`),
      );
      throw error;
    }
    const detail =
      error instanceof ApiError
        ? `${error.status} ${error.url}\n${error.body}`
        : `${url}\n${error instanceof Error ? error.message : String(error)}`;
    emitToast("error", i18n.t("plugin.toggleError.generic"), detail);
    throw error;
  }
}
