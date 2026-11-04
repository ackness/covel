import { useTranslation } from "react-i18next";
import type { PluginRuntimeSummary } from "@covel/shared";
import { formatSlotLabel, type ResolvedSlot } from "@/hooks/use-slot-config.js";
import {
  resolveDeclaredSlot,
  resolveTextRuntimeSlot,
} from "../session-prep/model-slot-helpers.js";
import { FunctionRuntimeModels } from "../function-runtime-models.js";

interface RuntimeModelBindingsProps {
  runtimes: readonly PluginRuntimeSummary[];
  resolvedSlots?: ResolvedSlot[];
  /** The session's saved overrides; shown, never edited here. */
  runtimeModelOverrides?: Record<string, string>;
  /** Opens the settings dialog on the model pane. */
  onOpenModelSettings?: () => void;
}

/**
 * Which model each step of a plugin runs on, as text. Changing it happens in
 * Settings; the link leads there.
 */
export function RuntimeModelBindings(props: RuntimeModelBindingsProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 px-2.5 pb-2">
      {props.runtimes
        .filter(
          (runtime) =>
            runtime.runtimeType === "agent" &&
            (runtime.model !== undefined ||
              runtime.stage !== undefined ||
              runtime.trigger.type === "manual" ||
              runtime.trigger.type === "event"),
        )
        .map((runtime) => (
          <RuntimeModelBinding key={runtime.id} {...props} runtime={runtime} />
        ))}
      <FunctionRuntimeModels
        runtimes={props.runtimes}
        resolvedSlots={props.resolvedSlots}
        className="space-y-2"
      />
      {props.onOpenModelSettings && (
        <button
          type="button"
          className="text-xs underline"
          onClick={props.onOpenModelSettings}
        >
          {t("session.goToSettings")}
        </button>
      )}
    </div>
  );
}

function RuntimeModelBinding({
  runtime,
  resolvedSlots = [],
  runtimeModelOverrides,
}: RuntimeModelBindingsProps & { runtime: PluginRuntimeSummary }) {
  const { t } = useTranslation();
  const boundSlot = runtimeModelOverrides?.[runtime.id] ?? "";
  const declaredSlot = runtime.model ?? "default";
  // A declared slot that is not set up runs on the first text slot; a chosen
  // slot that is gone is reported.
  const runtimeDefault = boundSlot
    ? null
    : resolveTextRuntimeSlot(resolvedSlots, declaredSlot);
  const resolvedSlot = boundSlot
    ? resolveDeclaredSlot(resolvedSlots, boundSlot)
    : (runtimeDefault?.slot ?? null);
  const effectiveSlot = resolvedSlot?.tag === "text" ? resolvedSlot : null;
  return (
    <div className="block min-w-0 space-y-0.5 text-xs text-muted-foreground">
      <span className="block break-all font-mono">{runtime.id}</span>
      <span
        className="block break-all"
        role={effectiveSlot ? undefined : "status"}
      >
        {effectiveSlot
          ? runtimeDefault?.fallback
            ? t("plugin.runtimeModelFallback", {
                slot: declaredSlot,
                model: formatSlotLabel(effectiveSlot),
              })
            : formatSlotLabel(effectiveSlot)
          : t("plugin.runtimeModelMissing", {
              slot: boundSlot || declaredSlot,
            })}
      </span>
    </div>
  );
}
