import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database, Info, Loader2, RotateCw } from "lucide-react";
import {
  fetchModelDbInfo,
  getCapabilityOverrides,
  getCustomPresets,
  getParamOverrides,
  getSlotConfig,
  refreshModelDb,
  reloadLlmConfig,
  setCapabilityOverrides,
  setParamOverrides,
  setSlotConfig,
  slotBindingId,
  type ModelCapabilityInfo,
  type ModelDbInfo,
  type SlotConfigEntry,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { emitToast } from "@/lib/toast-channel.js";
import { useSession } from "@/stores/session-store.js";
import { LlmSlotCard } from "./llm-slot-card.js";
import {
  autoBindDiscoveredSlots as resolveAutoBindDiscoveredSlots,
  collectLlmSlotPresetCandidates,
  createVisibleSlotIds,
  discoverRuntimeSlotIds,
} from "./llm-slots-model.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { clearChangedSlotReasoningEfforts } from "./llm-reasoning-effort.js";
import { useSettingsRevision } from "../use-settings-revision.js";

/**
 * Pane that surfaces the `[covel.<slot>]` sections from llm.toml and lets the
 * user override each slot's preset and capability metadata. Legacy (non-
 * configured) environments fall back to a fixed slot list.
 */
export function LlmSlotsPane() {
  const { t } = useTranslation();
  const { state, boot } = useSession();
  const llm = state.llmConfig;
  const isConfigured = llm?.configured ?? false;

  const [slotConfig, setSlotConfigLocal] = useState<
    Record<string, SlotConfigEntry>
  >(() => getSlotConfig());
  const [capOverrides, setCapOverridesLocal] = useState<
    Record<string, Partial<ModelCapabilityInfo>>
  >(() => getCapabilityOverrides());
  const [editingSlot, setEditingSlot] = useState<string | null>(null);
  const [modelDbInfo, setModelDbInfo] = useState<ModelDbInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloading, setReloading] = useState(false);
  const revision = useSettingsRevision([
    "llm.providers",
    "llm.slotConfig",
    "llm.capabilityOverrides",
  ]);
  useEffect(() => {
    setSlotConfigLocal(getSlotConfig());
    setCapOverridesLocal(getCapabilityOverrides());
  }, [revision]);

  useEffect(() => {
    fetchModelDbInfo()
      .then(setModelDbInfo)
      .catch(ignoreError("fetch model db info"));
  }, []);

  const customPresets = getCustomPresets();
  const allPresets = collectLlmSlotPresetCandidates(
    state.presets,
    customPresets,
  );

  const configuredSlots = isConfigured ? Object.keys(llm!.slots) : [];
  const discoveredSlotIds = useMemo(
    () => discoverRuntimeSlotIds(state.plugins),
    [state.plugins],
  );
  const slots = useMemo(
    () =>
      createVisibleSlotIds({
        isConfigured,
        configuredSlots,
        discoveredSlotIds,
      }),
    [isConfigured, configuredSlots.join("\n"), discoveredSlotIds.join("\n")],
  );

  const commitSlot = (next: Record<string, SlotConfigEntry>) => {
    const currentParamOverrides = getParamOverrides();
    const nextParamOverrides = clearChangedSlotReasoningEfforts(
      slotConfig,
      next,
      currentParamOverrides,
    );
    if (nextParamOverrides !== currentParamOverrides) {
      setParamOverrides(nextParamOverrides);
    }
    setSlotConfigLocal(next);
    setSlotConfig(next);
  };

  const autoBindDiscoveredSlots = () => {
    commitSlot(
      resolveAutoBindDiscoveredSlots(slotConfig, discoveredSlotIds, allPresets),
    );
  };

  const updateCapOverride = (
    slotId: string,
    patch: Partial<ModelCapabilityInfo>,
  ) => {
    const next = {
      ...capOverrides,
      [slotId]: { ...capOverrides[slotId], ...patch },
    };
    setCapOverridesLocal(next);
    setCapabilityOverrides(next);
  };

  const resetCapOverride = (slotId: string) => {
    const next = { ...capOverrides };
    delete next[slotId];
    setCapOverridesLocal(next);
    setCapabilityOverrides(next);
  };

  const handleReloadConfig = async () => {
    setReloading(true);
    try {
      const result = await reloadLlmConfig();
      // Refetch the config bundle (presets / plugins / llm-config) into the
      // store so the slot list + "missing slot" checks reflect the new file.
      // BOOT_SUCCESS preserves any active session/world/messages.
      await boot();
      if (result.ok) {
        emitToast(
          "success",
          t("settings.llm.reloadOk", "Configuration reloaded"),
          t("settings.llm.reloadOkDetail", {
            count: result.slots.length,
            slots: result.slots.join(", "),
            defaultValue: "{{count}} slot(s) active: {{slots}}",
          }),
        );
      } else {
        emitToast(
          "error",
          t("settings.llm.reloadFailed", "llm.toml could not be parsed"),
          result.error ?? "",
        );
      }
    } catch {
      // request() already surfaced a transport/HTTP toast.
    } finally {
      setReloading(false);
    }
  };

  const handleRefreshModelDb = async () => {
    setRefreshing(true);
    emitToast("info", t("settings.modelDbRefreshStarted"));
    try {
      const result = await refreshModelDb();
      setModelDbInfo({
        available: true,
        count: result.count,
        updatedAt: new Date().toISOString(),
      });
      emitToast(
        "success",
        t("settings.modelDbRefreshSucceeded", { count: result.count }),
      );
    } catch (error) {
      emitToast(
        "error",
        t("settings.modelDbRefreshFailed"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Relationship summary — explains how slots fit into the bigger picture.
          O-4 audit finding: players were seeing "slot / preset / key" as three
          disconnected tabs without any indication that they form a chain. */}
      <div className="border border-border/60 bg-muted/20 px-3 py-2 space-y-1.5">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t(
            "settings.slotChainSummary",
            "Plugin tasks → model roles → providers and models → API keys.",
          )}
        </p>
        <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/80 flex-wrap">
          <span className="px-1.5 py-0.5 rounded bg-background border border-border">
            {t("settings.chainRuntime", "Plugin task")}
          </span>
          <span className="text-muted-foreground/50">▸</span>
          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
            {t("settings.chainSlot", "Model role")}
          </span>
          <span className="text-muted-foreground/50">▸</span>
          <span className="px-1.5 py-0.5 rounded bg-background border border-border">
            {t("settings.chainPreset", "Provider and model")}
          </span>
          <span className="text-muted-foreground/50">▸</span>
          <span className="px-1.5 py-0.5 rounded bg-background border border-border">
            {t("settings.chainKey", "API key")}
          </span>
        </div>
      </div>
      {/* Manual hot-reload: re-read llm.toml on the server and apply it to the
          live gateway without restarting. */}
      <div className="flex items-center justify-between gap-2 border border-border/60 bg-muted/20 px-3 py-2">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t(
            "settings.llm.reloadHint",
            "Edited llm.toml? Reload to apply your slots without restarting the app.",
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="text-[11px] shrink-0"
          disabled={reloading}
          onClick={handleReloadConfig}
        >
          {reloading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RotateCw className="w-3 h-3" />
          )}
          <span className="ml-1">
            {t("settings.llm.reloadConfig", "Reload config")}
          </span>
        </Button>
      </div>
      {llm?.error && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive leading-relaxed">
          {t("settings.llm.parseError", {
            error: llm.error,
            defaultValue:
              "llm.toml could not be parsed — using the built-in default. Fix it and reload: {{error}}",
          })}
        </div>
      )}
      {isConfigured && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="w-3 h-3" />
          <span>{t("settings.configuredByToml")}</span>
        </div>
      )}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground italic">
        <Info className="w-3 h-3 shrink-0" />
        <span>{t("settings.slotPingMovedHint")}</span>
      </div>
      {discoveredSlotIds.length > 0 && (
        <div className="border border-border/70 bg-muted/20 px-3 py-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="space-y-1">
              <div className="text-xs font-medium">
                {t(
                  "settings.runtimeSlotsDiscovered",
                  "Runtime-requested slots",
                )}
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t(
                  "settings.runtimeSlotsDiscoveredHint",
                  "These slot names were discovered from active plugin runtimes and image-provider settings. Add or bind presets here so plugins can resolve them.",
                )}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-[11px] shrink-0"
              onClick={autoBindDiscoveredSlots}
            >
              {t("settings.autoBindSlots", "Auto-bind")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {discoveredSlotIds.map((slotId) => (
              <Badge
                key={slotId}
                variant={
                  slotBindingId(slotConfig[slotId]) ? "default" : "outline"
                }
                className="text-[10px]"
              >
                {slotId}
                {slotBindingId(slotConfig[slotId]) ? " ✓" : ""}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {slots.map((slotId) => (
        <LlmSlotCard
          key={`${slotId}:${modelDbInfo?.updatedAt ?? ""}`}
          slotId={slotId}
          slotConfig={slotConfig}
          serverSlot={isConfigured ? llm!.slots[slotId] : null}
          allPresets={allPresets}
          capOverride={capOverrides[slotId]}
          isConfigured={isConfigured}
          isFirst={isConfigured && slotId === configuredSlots[0]}
          isDiscovered={discoveredSlotIds.includes(slotId)}
          isEditing={editingSlot === slotId}
          commitSlot={commitSlot}
          onToggleEditing={() =>
            setEditingSlot(editingSlot === slotId ? null : slotId)
          }
          onResetCapability={() => resetCapOverride(slotId)}
          onUpdateCapability={(patch) => updateCapOverride(slotId, patch)}
        />
      ))}

      <div className="border border-dashed border-border p-3 space-y-2 mt-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
            <Database className="w-3 h-3" />
            {t("settings.modelDatabase")}
          </h4>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] px-2"
            disabled={refreshing}
            onClick={handleRefreshModelDb}
          >
            {refreshing ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <RotateCw className="w-3 h-3 mr-1" />
            )}
            {t("settings.updateFromGitHub")}
          </Button>
        </div>
        {modelDbInfo?.available ? (
          <div className="text-[10px] text-muted-foreground space-y-0.5">
            <div>{t("settings.modelCount", { count: modelDbInfo.count })}</div>
            <div>
              {t("settings.updatedAt", {
                date: modelDbInfo.updatedAt
                  ? new Date(modelDbInfo.updatedAt).toLocaleDateString()
                  : "?",
              })}
            </div>
          </div>
        ) : (
          <div className="text-[10px] text-muted-foreground">
            {t("settings.dbUnavailable")}
          </div>
        )}
      </div>
    </div>
  );
}
