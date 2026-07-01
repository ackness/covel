import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database, Info, Loader2, Pencil, RotateCw } from "lucide-react";
import {
  fetchModelDbInfo,
  getCapabilityOverrides,
  getCustomPresets,
  getSlotConfig,
  mergeCapability,
  refreshModelDb,
  reloadLlmConfig,
  setCapabilityOverrides,
  setSlotConfig,
  type ModelCapabilityInfo,
  type ModelDbInfo,
  type SlotConfigEntry,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { emitToast } from "@/lib/toast-channel.js";
import { useSession } from "@/stores/session-store.js";
import { CapabilityEditor, CapabilityTags } from "./llm-capability-controls.js";
import {
  autoBindDiscoveredSlots as resolveAutoBindDiscoveredSlots,
  collectLlmSlotPresetCandidates,
  createVisibleSlotIds,
  discoverRuntimeSlotIds,
} from "./llm-slots-model.js";
import { ignoreError } from "@/lib/ignore-error.js";

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
    () => discoverRuntimeSlotIds(state.packages),
    [state.packages],
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

  const getEffectiveCapability = (
    slotId: string,
  ): ModelCapabilityInfo | undefined => {
    const serverCap = isConfigured ? llm!.slots[slotId]?.capability : undefined;
    return mergeCapability(serverCap, capOverrides[slotId]);
  };

  const handleReloadConfig = async () => {
    setReloading(true);
    try {
      const result = await reloadLlmConfig();
      // Refetch the config bundle (presets / packages / llm-config) into the
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
    try {
      const result = await refreshModelDb();
      if (result.ok) {
        setModelDbInfo({
          available: true,
          count: result.count,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {
      // silent
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
            "Plugins → Slots → Presets → API keys. Change a preset to swap models; manage keys in the Keys tab.",
          )}
        </p>
        <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/80 flex-wrap">
          <span className="px-1.5 py-0.5 rounded bg-background border border-border">
            {t("settings.chainRuntime", "Runtime")}
          </span>
          <span className="text-muted-foreground/50">▸</span>
          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
            {t("settings.chainSlot", "Slot")}
          </span>
          <span className="text-muted-foreground/50">▸</span>
          <span className="px-1.5 py-0.5 rounded bg-background border border-border">
            {t("settings.chainPreset", "Preset")}
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
                variant={slotConfig[slotId]?.presetId ? "default" : "outline"}
                className="text-[10px]"
              >
                {slotId}
                {slotConfig[slotId]?.presetId ? " ✓" : ""}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {slots.map((slotId) => {
        const selectedPresetId = slotConfig[slotId]?.presetId ?? "";
        const selectedPreset = allPresets.find(
          (p) => p.id === selectedPresetId,
        );
        const serverSlot = isConfigured ? llm!.slots[slotId] : null;
        const effectiveProvider =
          selectedPreset?.provider ?? serverSlot?.provider ?? "";
        const effectiveModel = selectedPreset?.model ?? serverSlot?.model ?? "";
        const effectiveProtocol = serverSlot?.protocol ?? "";
        const isRequired = !isConfigured && slotId === "default";
        const isFirst = isConfigured && slotId === configuredSlots[0];
        const isDiscovered = discoveredSlotIds.includes(slotId);
        const isVirtualSlot = isDiscovered && !serverSlot;
        const effectiveCap = isConfigured
          ? getEffectiveCapability(slotId)
          : null;
        const hasCapOverride = isConfigured && !!capOverrides[slotId];
        const isEditing = editingSlot === slotId;

        return (
          <div key={slotId} className="border border-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{slotId}</span>
              <div className="flex items-center gap-1">
                {isRequired && (
                  <Badge variant="default" className="text-[10px]">
                    {t("settings.required", "required")}
                  </Badge>
                )}
                {isFirst && (
                  <Badge variant="default" className="text-[10px]">
                    {t("settings.default", "default")}
                  </Badge>
                )}
                {isDiscovered && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("settings.runtime", "runtime")}
                  </Badge>
                )}
                {isVirtualSlot && (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-amber-600 border-amber-400"
                  >
                    {t("settings.frontendOverlay", "frontend overlay")}
                  </Badge>
                )}
                {serverSlot?.fallback && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("settings.fallbackSlot", {
                      slot: serverSlot.fallback,
                      defaultValue: "fallback: {{slot}}",
                    })}
                  </Badge>
                )}
                {selectedPreset && (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-amber-600 border-amber-400"
                  >
                    {t("settings.overrideApplied")}
                  </Badge>
                )}
              </div>
            </div>

            <select
              value={selectedPresetId}
              onChange={(e) => {
                const val = e.target.value;
                if (val) {
                  commitSlot({ ...slotConfig, [slotId]: { presetId: val } });
                } else {
                  const updated = { ...slotConfig };
                  delete updated[slotId];
                  commitSlot(updated);
                }
              }}
              className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">
                --{" "}
                {serverSlot
                  ? t("settings.useBaseSlotConfig", "Use base slot config")
                  : isDiscovered
                    ? t("settings.selectPreset", "Select preset")
                    : isRequired
                      ? t("settings.selectPreset")
                      : t("settings.noPresetFallback")}{" "}
                --
              </option>
              {state.presets.length > 0 && (
                <optgroup label={t("settings.builtInPresets", "Built-in")}>
                  {state.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.provider}/{p.model})
                    </option>
                  ))}
                </optgroup>
              )}
              {customPresets.length > 0 && (
                <optgroup label={t("settings.customPresets", "Custom")}>
                  {customPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.provider}/{p.model})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            <div className="text-xs text-muted-foreground grid grid-cols-3 gap-1">
              <span>
                {t("settings.providerLabel", "Provider")}:{" "}
                {effectiveProvider || "—"}
              </span>
              <span>
                {t("settings.modelLabel", "Model")}: {effectiveModel || "—"}
              </span>
              <span>
                {selectedPreset
                  ? selectedPreset.isCustom
                    ? t("settings.presetCustom", "Preset: custom")
                    : t("settings.presetOverride", "Preset: override")
                  : t("settings.protocolLabel", {
                      protocol:
                        (effectiveProtocol || "").replace("-v1", "") || "—",
                      defaultValue: "Protocol: {{protocol}}",
                    })}
              </span>
            </div>

            {isConfigured && effectiveCap && (
              <CapabilityTags capability={effectiveCap} />
            )}

            {isConfigured && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-1.5"
                  onClick={() => setEditingSlot(isEditing ? null : slotId)}
                >
                  <Pencil className="w-3 h-3 mr-0.5" />
                  {isEditing
                    ? t("settings.collapseCapability")
                    : t("settings.editCapability")}
                </Button>
                {hasCapOverride && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] px-1.5 text-amber-600"
                    onClick={() => resetCapOverride(slotId)}
                  >
                    <RotateCw className="w-3 h-3 mr-0.5" />
                    {t("settings.resetOverride")}
                  </Button>
                )}
              </div>
            )}

            {isConfigured && isEditing && (
              <CapabilityEditor
                serverCap={serverSlot?.capability}
                override={capOverrides[slotId]}
                onUpdate={(patch) => updateCapOverride(slotId, patch)}
              />
            )}
          </div>
        );
      })}

      {isConfigured && (
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
              <div>
                {t("settings.modelCount", { count: modelDbInfo.count })}
              </div>
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
      )}
    </div>
  );
}
