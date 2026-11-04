import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PluginUserSettingSpec } from "@covel/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { getSettings } from "@/settings/store.js";
import { useSetting } from "@/settings/use-settings.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import { resolveProviderSlot } from "./model-slot-helpers.js";

/**
 * Function runtimes can declare several provider roles, each with its own
 * setting. The prep screen shows the current choice as text; Settings → the
 * plugin holds the editor.
 */
export function ProviderSlotSetting({
  pluginId,
  setting,
  worldDefault,
  isMissingDeclaredSlot,
  onOpenSettings,
}: {
  pluginId: string;
  setting: PluginUserSettingSpec;
  worldDefault?: unknown;
  isMissingDeclaredSlot: (slotId: string) => boolean;
  /** Opens this plugin's page in Settings, the one place to change it. */
  onOpenSettings: () => void;
}) {
  const { t, i18n } = useTranslation();
  const store = getSettings();
  const key = `plugin.${pluginId}.${setting.key}`;
  const [value] = useSetting<string>(key);
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
      <Button
        type="button"
        variant="link"
        size="sm"
        className="ml-auto h-auto px-0 py-0 text-xs"
        aria-label={`${t("plugin.changeInSettings")} · ${label}`}
        onClick={onOpenSettings}
      >
        {t("plugin.changeInSettings")}
      </Button>
    </div>
  );
}
