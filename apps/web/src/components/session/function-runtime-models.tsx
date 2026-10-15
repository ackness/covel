import { useTranslation } from "react-i18next";
import type { PluginRuntimeSummary } from "@covel/shared";
import { formatSlotLabel, type ResolvedSlot } from "@/hooks/use-slot-config.js";
import { resolveTextRuntimeSlot } from "./session-prep/model-slot-helpers.js";

/** Functions expose their declared text slot without a session override control. */
export function FunctionRuntimeModels({
  runtimes,
  resolvedSlots = [],
  className,
}: {
  runtimes: readonly PluginRuntimeSummary[];
  resolvedSlots?: ResolvedSlot[];
  className?: string;
}) {
  const { t } = useTranslation();
  const models = runtimes.flatMap((runtime) =>
    runtime.runtimeType === "function" && runtime.model !== undefined
      ? [{ id: runtime.id, slot: runtime.model }]
      : [],
  );
  if (models.length === 0) return null;
  return (
    <div className={className}>
      {models.map(({ id, slot }) => {
        const resolved = resolveTextRuntimeSlot(resolvedSlots, slot);
        return (
          <div
            key={id}
            className="min-w-0 space-y-1 text-xs text-muted-foreground"
          >
            <span className="block break-all font-mono">{id}</span>
            <span className="block break-all">
              {t("plugin.useRuntimeDefault", { slot })}
            </span>
            <span
              className="block break-all"
              role={resolved ? undefined : "status"}
            >
              {resolved
                ? resolved.fallback
                  ? t("plugin.runtimeModelFallback", {
                      slot,
                      model: formatSlotLabel(resolved.slot),
                    })
                  : formatSlotLabel(resolved.slot)
                : t("plugin.runtimeModelMissing", { slot })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
