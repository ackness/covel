import { useTranslation } from "react-i18next";
import { FolderOpen, Info } from "lucide-react";
import { getCustomPresets, type PresetSummary } from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { SettingWidget } from "../widgets/index.js";
import { useSettingsStore } from "../use-settings.js";
import { useSession } from "@/stores/session-store.js";
import { PingButton } from "@/components/shared/ping-button.js";
import { isDesktopApp, openLlmToml } from "@/lib/desktop-bridge.js";

/**
 * Shape we need per preset for rendering — a minimal projection of both
 * server-registered (`PresetSummary`) and client-defined ("custom") presets.
 *
 * `baseUrl`/`slotBindings` only exist on server-registered presets; for
 * custom presets those fields stay undefined and the UI falls back gracefully.
 */
interface PresetRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl?: string;
  slotBindings?: string[];
  isCustom: boolean;
}

/**
 * API keys pane — renders one SecretWidget per registered `keys.<provider>`
 * entry plus a Ping button under each preset using it.
 *
 * This is the authoritative place to validate a freshly-entered API key:
 * `PingButton` shows baseUrl + slot bindings in its tooltip so the operator
 * knows exactly which target was hit.
 */
export function LlmKeysPane() {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const { state } = useSession();

  const isConfigured = state.llmConfig?.configured ?? false;

  const keyEntries = store.listEntries().filter((e) => e.backend === "keys");

  const customPresets = getCustomPresets();
  const allPresets: PresetRow[] = [
    ...state.presets.map((p: PresetSummary) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      baseUrl: p.baseUrl,
      slotBindings: p.slotBindings,
      isCustom: false,
    })),
    ...customPresets.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      baseUrl: p.baseUrl,
      slotBindings: undefined,
      isCustom: true,
    })),
  ];

  if (keyEntries.length === 0) {
    const desktop = isDesktopApp();
    return (
      <div className="border border-dashed border-border p-4 space-y-3 text-xs">
        <div className="flex items-start gap-2">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-muted-foreground" />
          <div className="space-y-1">
            <div className="font-medium text-sm">
              {t("settings.noProvidersTitle", "No providers registered yet")}
            </div>
            <p className="text-muted-foreground leading-relaxed">
              {desktop
                ? t(
                    "settings.noProvidersDesktopDesc",
                    "Open your local llm.toml and add at least one [covel.<slot>] section, then reload this dialog.",
                  )
                : t(
                    "settings.noProvidersWebDesc",
                    "This web build reads slot definitions from the server's llm.toml. Ask your operator to configure a slot, or run a desktop build where you can edit the file locally.",
                  )}
            </p>
          </div>
        </div>
        {desktop && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void openLlmToml().catch((err: unknown) => {
                console.error("[LlmKeysPane] openLlmToml failed", err);
              });
            }}
            className="text-[11px]"
          >
            <FolderOpen className="w-3 h-3 mr-1.5" />
            {t("settings.openLlmToml", "Open llm.toml")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Info className="w-3 h-3" />
        <span>
          {isConfigured
            ? t("settings.keysConfiguredDesc")
            : t("settings.keysLocalDesc")}
        </span>
      </div>
      {keyEntries.map((entry) => {
        const providerId = entry.key.startsWith("keys.")
          ? entry.key.slice(5)
          : entry.key;
        const hasKey = (store.get<string>(entry.key) ?? "").trim().length > 0;
        const providerPresets = allPresets.filter(
          (p) => p.provider === providerId,
        );
        return (
          <div key={entry.key} className="border border-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs">
                <strong>{providerId}</strong>
                {hasKey ? (
                  <Badge variant="default" className="text-[10px]">
                    {t("settings.keyConfigured")}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px]">
                    {t("settings.keyUnconfigured")}
                  </Badge>
                )}
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">
                {providerId.toUpperCase().replace(/-/g, "_")}_API_KEY
              </span>
            </div>
            <SettingWidget entry={entry} />
            {hasKey && providerPresets.length > 0 && (
              <div className="space-y-2 pt-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                  {t("settings.pingTest")}
                </span>
                {providerPresets.map((preset) => (
                  <PresetPingRow key={preset.id} preset={preset} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PresetPingRow({ preset }: { preset: PresetRow }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <PingButton target={{ kind: "preset", presetId: preset.id }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate">
          <span className="truncate">{preset.name}</span>
          <span className="text-[10px] text-muted-foreground">
            ({preset.model})
          </span>
          {preset.isCustom && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-auto">
              custom
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
          {preset.baseUrl && (
            <span className="truncate font-mono" title={preset.baseUrl}>
              {preset.baseUrl}
            </span>
          )}
          {preset.slotBindings && preset.slotBindings.length > 0 && (
            <span className="shrink-0">→ {preset.slotBindings.join(", ")}</span>
          )}
        </div>
      </div>
    </div>
  );
}
