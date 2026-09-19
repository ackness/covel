import { useTranslation } from "react-i18next";
import type { PluginRuntimeSummary } from "@covel/shared";
import {
  formatSlotBindingLabel,
  formatSlotLabel,
  type ResolvedSlot,
} from "@/hooks/use-slot-config.js";
import { resolveDeclaredSlot } from "../session-prep/model-slot-helpers.js";
import { useRuntimeModelSlotOverride } from "./runtime-model-slot-override.js";
import type { RuntimeModelOverrideChange } from "./types.js";

interface RuntimeModelBindingsProps {
  runtimes: readonly PluginRuntimeSummary[];
  resolvedSlots?: ResolvedSlot[];
  sessionId?: string;
  executing?: boolean;
  runtimeModelOverrides?: Record<string, string>;
  onChange?: RuntimeModelOverrideChange;
}

/** Each agent runtime owns a binding; function runtimes do not use this gateway. */
export function RuntimeModelBindings(props: RuntimeModelBindingsProps) {
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
    </div>
  );
}

function RuntimeModelBinding({
  runtime,
  resolvedSlots = [],
  sessionId,
  executing,
  runtimeModelOverrides,
  onChange,
}: RuntimeModelBindingsProps & { runtime: PluginRuntimeSummary }) {
  const { t } = useTranslation();
  const [boundSlot, setSlot, error] = useRuntimeModelSlotOverride({
    runtimeKey: runtime.id,
    sessionId,
    runtimeModelOverrides,
    onChange,
  });
  const slots = resolvedSlots.filter((slot) => slot.tag === "text");
  const declaredSlot = runtime.model ?? "default";
  const effectiveSlot = resolveDeclaredSlot(slots, boundSlot || declaredSlot);
  const missingOverride =
    boundSlot && !slots.some((slot) => slot.slotId === boundSlot);
  return (
    <label className="block min-w-0 space-y-1 text-xs text-muted-foreground">
      <span className="block break-all font-mono">{runtime.id}</span>
      <select
        aria-label={`${t("plugin.modelBinding")} · ${runtime.id}`}
        value={boundSlot}
        disabled={executing || !sessionId || !onChange}
        onChange={(event) => setSlot(event.target.value)}
        className="w-full min-w-0 rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
      >
        <option value="">
          {t("plugin.useRuntimeDefault", { slot: declaredSlot })}
        </option>
        {missingOverride && (
          <option value={boundSlot}>
            {t("plugin.runtimeModelMissing", { slot: boundSlot })}
          </option>
        )}
        {slots.map((slot) => (
          <option key={slot.slotId} value={slot.slotId}>
            {formatSlotBindingLabel(slot)}
          </option>
        ))}
      </select>
      <span
        className="block break-all"
        role={effectiveSlot ? undefined : "status"}
      >
        {effectiveSlot
          ? formatSlotLabel(effectiveSlot)
          : t("plugin.runtimeModelMissing", {
              slot: boundSlot || declaredSlot,
            })}
      </span>
      {error && (
        <span className="block text-destructive" role="alert" title={error}>
          {t("plugin.modelOverrideFailed")}
        </span>
      )}
    </label>
  );
}
