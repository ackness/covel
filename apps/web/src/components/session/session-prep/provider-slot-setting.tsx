import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PluginUserSettingSpec } from "@covel/shared";
import { Badge } from "@/components/ui/badge.js";
import {
  formatSlotBindingLabel,
  type ResolvedSlot,
} from "@/hooks/use-slot-config.js";
import { getSettings } from "@/settings/store.js";
import { useSetting } from "@/settings/use-settings.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import { emitToast } from "@/lib/toast-channel.js";
import { resolveProviderSlot } from "./model-slot-helpers.js";

/** Function runtimes can declare several provider roles, each with its own setting. */
export function ProviderSlotSetting({
  pluginId,
  setting,
  worldDefault,
  resolvedSlots,
  isMissingDeclaredSlot,
}: {
  pluginId: string;
  setting: PluginUserSettingSpec;
  worldDefault?: unknown;
  resolvedSlots: ResolvedSlot[];
  isMissingDeclaredSlot: (slotId: string) => boolean;
}) {
  const { t, i18n } = useTranslation();
  const store = getSettings();
  const key = `plugin.${pluginId}.${setting.key}`;
  const [value, setValue] = useSetting<string>(key);
  const override = store.has(key) ? value : undefined;
  const defaultSlot =
    typeof worldDefault === "string"
      ? worldDefault
      : typeof setting.default === "string"
        ? setting.default
        : undefined;
  const { effectiveSlot, missing, isOverridden } = resolveProviderSlot({
    manifestDefault: defaultSlot,
    override,
    isMissing: isMissingDeclaredSlot,
  });
  const label = resolveI18n(setting.label, i18n.language) || setting.key;
  const change = async (next: string) => {
    if (next) await setValue(next);
    else {
      try {
        await store.clear(key);
      } catch {
        emitToast("error", t("settings.saveFailed"));
      }
    }
  };
  return (
    <div className="mt-2.5 ml-9 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <KeyRound className="h-3 w-3 shrink-0" aria-hidden />
      <span className="font-medium">{label}</span>
      <Badge variant={missing ? "destructive" : "outline"} className="text-xs">
        {missing
          ? t("plugin.runtimeModelMissing", { slot: effectiveSlot })
          : effectiveSlot}
      </Badge>
      {isOverridden && (
        <Badge variant="secondary" className="text-xs">
          {t("plugin.providerSlotOverridden")}
        </Badge>
      )}
      <select
        aria-label={label}
        value={override ?? ""}
        onChange={(event) => void change(event.target.value)}
        className="ml-auto w-full min-w-0 max-w-70 rounded border border-border bg-background px-2 py-1 text-xs"
      >
        <option value="">
          {t("plugin.useRuntimeDefault", { slot: defaultSlot ?? "default" })}
        </option>
        {override &&
          !resolvedSlots.some((slot) => slot.slotId === override) && (
            <option value={override}>
              {t("plugin.runtimeModelMissing", { slot: override })}
            </option>
          )}
        {resolvedSlots.map((slot) => (
          <option key={slot.slotId} value={slot.slotId}>
            {formatSlotBindingLabel(slot)}
          </option>
        ))}
      </select>
    </div>
  );
}
