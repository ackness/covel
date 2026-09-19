import { FrameworkCapability } from "@covel/shared";
import { useTranslation } from "react-i18next";
import { useSession } from "@/stores/session-store.js";
import { usePluginNamespace } from "@/stores/plugin-data-store.js";

/** Derived memory health follows the same persisted/live data path as its panel. */
export function MemoryUpdateNotice() {
  const { state } = useSession();
  const { t } = useTranslation();
  const host = state.plugins?.find(
    (plugin) =>
      state.session?.activePlugins?.includes(plugin.id) &&
      plugin.capabilities.includes(FrameworkCapability.MemoryPanel),
  );
  const data = usePluginNamespace(host?.id ?? "", "_memory");
  const update = data.update;
  if (
    !host ||
    !update ||
    typeof update !== "object" ||
    !("status" in update) ||
    update.status !== "failed"
  )
    return null;
  const error =
    "error" in update && typeof update.error === "string"
      ? update.error
      : undefined;
  return (
    <div
      role="status"
      className="m-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <p className="font-medium">{t("session.memoryUpdateFailed")}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("session.memoryUpdateFailedHint")}
      </p>
      {error && (
        <details className="mt-2 text-xs">
          <summary>{t("session.memoryUpdateErrorDetails")}</summary>
          <p className="mt-1 wrap-break-word">{error}</p>
        </details>
      )}
    </div>
  );
}
