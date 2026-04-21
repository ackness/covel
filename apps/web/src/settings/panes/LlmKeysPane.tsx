import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Info,
  Loader2,
  XCircle,
  Zap,
} from "lucide-react";
import {
  getCustomPresets,
  pingPreset,
  type PingResult,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { SettingWidget } from "../widgets/index.js";
import { useSettingsStore } from "../use-settings.js";
import { useSession } from "@/stores/session-store.js";

/**
 * API keys pane — renders one SecretWidget per registered `keys.<provider>`
 * entry plus a Ping button under each provider for every preset using it.
 */
export function LlmKeysPane() {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const { state } = useSession();
  const [pingResults, setPingResults] = useState<
    Record<string, PingResult & { testing?: boolean }>
  >({});

  const isConfigured = state.llmConfig?.configured ?? false;

  const keyEntries = store.listEntries().filter((e) => e.backend === "keys");

  const customPresets = getCustomPresets();
  const allPresets = [
    ...state.presets.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      isCustom: false,
    })),
    ...customPresets.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      isCustom: true,
    })),
  ];

  const handlePing = async (presetId: string) => {
    setPingResults((prev) => ({
      ...prev,
      [presetId]: { ok: false, latencyMs: 0, testing: true },
    }));
    try {
      const result = await pingPreset(presetId);
      setPingResults((prev) => ({ ...prev, [presetId]: result }));
    } catch (err) {
      setPingResults((prev) => ({
        ...prev,
        [presetId]: {
          ok: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : "Network error",
        },
      }));
    }
  };

  if (keyEntries.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No providers registered. Configure at least one slot in `llm.toml` to
        surface API key inputs.
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
              <div className="space-y-1.5 pt-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                  {t("settings.pingTest")}
                </span>
                {providerPresets.map((preset) => {
                  const ping = pingResults[preset.id];
                  const isTesting = ping?.testing;
                  return (
                    <div
                      key={preset.id}
                      className="flex items-center gap-2 text-xs"
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px] px-2.5 shrink-0"
                        disabled={isTesting}
                        onClick={() => handlePing(preset.id)}
                      >
                        {isTesting ? (
                          <Loader2 className="w-3 h-3 animate-spin mr-1" />
                        ) : (
                          <Zap className="w-3 h-3 mr-1" />
                        )}
                        Ping
                      </Button>
                      <span className="truncate text-muted-foreground">
                        {preset.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        ({preset.model})
                      </span>
                      {ping && !isTesting && (
                        <span className="flex items-center gap-1 ml-auto shrink-0">
                          {ping.ok ? (
                            <>
                              <CheckCircle2 className="w-3 h-3 text-green-500" />
                              <span className="text-green-600 font-mono">
                                {ping.ttfbMs ?? ping.latencyMs}ms
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                TTFB
                              </span>
                            </>
                          ) : (
                            <>
                              <XCircle className="w-3 h-3 text-destructive" />
                              <span
                                className="text-destructive truncate max-w-[120px]"
                                title={ping.error}
                              >
                                {ping.error?.slice(0, 30)}
                              </span>
                            </>
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
