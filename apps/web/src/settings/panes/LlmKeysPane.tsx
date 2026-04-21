import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  FolderOpen,
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
import { isDesktopApp, openLlmToml } from "@/lib/desktop-bridge.js";

/**
 * Classify a raw error string into a ping failure category and produce
 * a short, human-actionable kind label plus the cleaned detail.
 */
function classifyPingError(raw: string | undefined): {
  kind: string;
  detail: string;
} {
  if (!raw) return { kind: "unknown", detail: "Unknown error" };
  const lower = raw.toLowerCase();
  if (/\b401\b|unauthoriz|invalid.+key|invalid.*api.?key/.test(lower)) {
    return { kind: "auth", detail: raw };
  }
  if (/\b403\b|forbidden/.test(lower)) return { kind: "forbidden", detail: raw };
  if (/\b404\b|not found/.test(lower)) return { kind: "not-found", detail: raw };
  if (/\b429\b|rate[-\s]?limit|too many/.test(lower))
    return { kind: "rate-limited", detail: raw };
  if (/\b5\d\d\b|server error|bad gateway|unavailable/.test(lower))
    return { kind: "server", detail: raw };
  if (/timeout|timed out|etimedout/.test(lower))
    return { kind: "timeout", detail: raw };
  if (
    /network|fetch|econnrefused|enotfound|socket|dns|offline|cors/.test(lower)
  )
    return { kind: "network", detail: raw };
  return { kind: "error", detail: raw };
}

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
    setPingResults((prev) => {
      const next = { ...prev };
      delete next[presetId];
      next[presetId] = { ok: false, latencyMs: 0, testing: true };
      return next;
    });
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
              <div className="space-y-1.5 pt-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                  {t("settings.pingTest")}
                </span>
                {providerPresets.map((preset) => {
                  const ping = pingResults[preset.id];
                  const isTesting = ping?.testing;
                  const errInfo = ping && !ping.ok ? classifyPingError(ping.error) : null;
                  return (
                    <div key={preset.id} className="space-y-1">
                      <div className="flex items-center gap-2 text-xs">
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
                                <Badge
                                  variant="destructive"
                                  className="text-[10px] font-mono uppercase"
                                >
                                  {errInfo?.kind ?? "error"}
                                </Badge>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                      {ping && !ping.ok && !isTesting && errInfo && (
                        <pre className="text-[10px] font-mono text-destructive/80 bg-destructive/5 border border-destructive/20 px-2 py-1 whitespace-pre-wrap break-all max-h-24 overflow-auto">
                          {errInfo.detail}
                        </pre>
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
