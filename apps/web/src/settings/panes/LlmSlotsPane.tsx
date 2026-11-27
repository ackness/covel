import { SettingsListFilter, SettingsListSearch } from "../list-controls.js";
import { useModelCapabilities } from "@/hooks/use-model-capabilities.js";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database, Loader2, RotateCw } from "lucide-react";
import {
  fetchModelDbInfo,
  getCapabilityOverrides,
  getCustomPresets,
  getParamOverrides,
  getSlotConfig,
  refreshModelDb,
  reloadLlmConfig,
  setCapabilityOverrides,
  slotBindingId,
  type ModelCapabilityInfo,
  type ModelDbInfo,
  type SlotConfigEntry,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  sameSettingValue,
  SettingsRevisionConflictError,
} from "@covel/settings";
import { useSettingsSave, useSettingsSaveQueue } from "../use-settings-save.js";
import { emitToast } from "@/lib/toast-channel.js";
import { useSession } from "@/stores/session-store.js";
import { LlmSlotCard } from "./llm-slot-card.js";
import {
  autoBindDiscoveredSlots as resolveAutoBindDiscoveredSlots,
  collectLlmSlotPresetCandidates,
} from "./llm-slots-model.js";
import { useLlmSlotIds } from "./use-llm-slot-ids.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { clearChangedSlotReasoningEfforts } from "./llm-reasoning-effort.js";
import { useSettingsRevision } from "../use-settings-revision.js";
import { useSettingsStore } from "../use-settings.js";
import { SettingsPaneHeader } from "../pane-layout.js";

const FILTER_FROM_SLOT_COUNT = 6;

/**
 * Pane that surfaces the `[covel.<slot>]` sections from llm.toml and lets the
 * user override each slot's preset and capability metadata. Unconfigured
 * environments fall back to a fixed slot list.
 */
export function LlmSlotsPane() {
  const { t, i18n } = useTranslation();
  const store = useSettingsStore();
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
  const [filter, setFilter] = useState("");
  const [unboundOnly, setUnboundOnly] = useState(false);
  const [modelDbInfo, setModelDbInfo] = useState<ModelDbInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [slotSaveError, setSlotSaveError] = useState<string | null>(null);
  const {
    enqueue: enqueueSlot,
    saving: savingSlot,
    mounted,
  } = useSettingsSaveQueue();
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
  const allPresets = useModelCapabilities(
    collectLlmSlotPresetCandidates(state.presets, customPresets),
    modelDbInfo?.updatedAt ?? undefined,
  );

  const { slots, configuredSlots, discoveredSlotIds } = useLlmSlotIds();

  const {
    save: saveCapabilities,
    saving: savingCapabilities,
    writable,
  } = useSettingsSave(() => setCapOverridesLocal(getCapabilityOverrides()));

  const commitSlot = async (
    next: Record<string, SlotConfigEntry>,
    touchedSlot?: string,
  ) => {
    if (!writable || !mounted.current) return;
    const changed = touchedSlot
      ? [touchedSlot]
      : [...new Set([...Object.keys(slotConfig), ...Object.keys(next)])].filter(
          (key) => !sameSettingValue(slotConfig[key], next[key]),
        );
    const requested = next;
    const result = enqueueSlot(async () => {
      const currentSlots = getSlotConfig();
      next = { ...currentSlots };
      for (const key of changed) {
        if (requested[key]) next[key] = requested[key];
        else delete next[key];
      }
      const currentParamOverrides = getParamOverrides();
      const nextParamOverrides = clearChangedSlotReasoningEfforts(
        currentSlots,
        next,
        currentParamOverrides,
      );
      try {
        await store.setMany({
          "llm.slotConfig": next,
          ...(nextParamOverrides !== currentParamOverrides
            ? { "llm.paramOverrides": nextParamOverrides }
            : {}),
        });
        if (mounted.current) setSlotConfigLocal(getSlotConfig());
      } catch (error) {
        const message = t("settings.saveFailed");
        if (mounted.current) {
          setSlotConfigLocal(getSlotConfig());
          setSlotSaveError(message);
        }
        if (!(error instanceof SettingsRevisionConflictError))
          emitToast("error", message);
      }
    });
    setSlotSaveError(null);
    await result;
  };

  const autoBindDiscoveredSlots = () => {
    commitSlot(
      resolveAutoBindDiscoveredSlots(
        slotConfig,
        discoveredSlotIds,
        allPresets,
        Object.fromEntries(
          Object.entries(llm?.slots ?? {}).map(([id, slot]) => [id, slot.tag]),
        ),
      ),
    );
  };

  const updateCapOverride = (
    slotId: string,
    patch: Partial<ModelCapabilityInfo>,
  ) => {
    return saveCapabilities(() => {
      const current = getCapabilityOverrides();
      return setCapabilityOverrides({
        ...current,
        [slotId]: {
          ...current[slotId],
          ...patch,
          ...(patch.pricing
            ? { pricing: { ...current[slotId]?.pricing, ...patch.pricing } }
            : {}),
        },
      });
    });
  };

  const resetCapOverride = (slotId: string) => {
    void saveCapabilities(() => {
      const next = { ...getCapabilityOverrides() };
      delete next[slotId];
      return setCapabilityOverrides(next);
    });
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
            defaultValue: "{{count}} AI role(s) active: {{slots}}",
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

  const isSlotBound = (slotId: string) =>
    Boolean(slotBindingId(slotConfig[slotId])) ||
    Boolean(isConfigured && llm?.slots[slotId]);
  const unboundCount = slots.filter((slotId) => !isSlotBound(slotId)).length;
  const showUnboundToggle =
    unboundOnly ||
    (slots.length > 3 && unboundCount > 0 && unboundCount < slots.length);
  const needle = filter.trim().toLowerCase();
  const visibleSlots = slots.filter((slotId) => {
    if (unboundOnly && isSlotBound(slotId)) return false;
    if (needle && !slotId.toLowerCase().includes(needle)) return false;
    return true;
  });

  return (
    <div className="space-y-3">
      {/* The title line states the chain the three LLM pages form: a player
          otherwise sees roles, providers and keys as unrelated pages. */}
      <SettingsPaneHeader
        title={t("settings.llmSlots", "AI roles")}
        description={t(
          "settings.slotChainSummary",
          "Plugin tasks → AI roles → providers and models → API keys.",
        )}
      />
      {/* Manual hot-reload: re-read llm.toml on the server and apply it to the
          live gateway without restarting. */}
      <div className="settings-group flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          {llm?.source && (
            <p className="break-all text-xs">
              {llm.source.kind === "file"
                ? t("settings.llm.activeFile", { path: llm.source.path })
                : t("settings.llm.activeBuiltin")}
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.llm.reloadHint",
              "Edited llm.toml? Reload to apply your AI roles without restarting the app.",
            )}
          </p>
        </div>
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
              "llm.toml could not be loaded. The currently active configuration has been kept. Fix it and reload: {{error}}",
          })}
        </div>
      )}
      <details className="text-[11px] leading-relaxed text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">
          {t("settings.slotNotesSummary")}
        </summary>
        <ul className="mt-1.5 list-disc space-y-1 pl-4">
          {isConfigured && <li>{t("settings.configuredByToml")}</li>}
          <li>{t("settings.slotPingMovedHint")}</li>
        </ul>
      </details>
      {discoveredSlotIds.length > 0 && (
        <div className="settings-group space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <div className="text-xs font-medium">
                {t(
                  "settings.runtimeSlotsDiscovered",
                  "Plugin-declared AI roles",
                )}
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t(
                  "settings.runtimeSlotsDiscoveredHint",
                  "These AI roles come from loaded plugins and their saved settings. Assign an appropriate provider and model to each one.",
                )}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-auto max-w-full py-1.5 text-xs whitespace-normal"
              disabled={savingSlot || savingCapabilities || !writable}
              onClick={autoBindDiscoveredSlots}
            >
              {t("settings.autoBindSlots", "Assign automatically")}
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
      {slotSaveError && (
        <p role="alert" className="text-xs text-destructive">
          {slotSaveError}
        </p>
      )}
      {/* A long llm.toml makes this page long; a short one needs no filter. */}
      {(slots.length > FILTER_FROM_SLOT_COUNT ||
        filter ||
        showUnboundToggle) && (
        <div className="flex flex-wrap items-center gap-2">
          {(slots.length > FILTER_FROM_SLOT_COUNT || filter) && (
            <SettingsListSearch
              label={t("settings.slotFilterPlaceholder")}
              value={filter}
              onChange={setFilter}
              className="sm:max-w-72"
            />
          )}
          {showUnboundToggle && (
            <SettingsListFilter
              active={unboundOnly}
              onClick={() => setUnboundOnly((current) => !current)}
              label={t("settings.slotFilterUnboundOnly", {
                count: unboundCount,
              })}
            />
          )}
        </div>
      )}
      {visibleSlots.length === 0 && slots.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          <p>{t("settings.slotFilterEmpty")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              setFilter("");
              setUnboundOnly(false);
            }}
          >
            {t("settings.github.resetFilters")}
          </Button>
        </div>
      )}
      <div aria-busy={savingSlot} className="min-w-0 space-y-3">
        {visibleSlots.map((slotId) => (
          <LlmSlotCard
            key={slotId}
            slotId={slotId}
            catalogRevision={modelDbInfo?.updatedAt ?? undefined}
            slotConfig={slotConfig}
            serverSlot={isConfigured ? llm!.slots[slotId] : null}
            allPresets={allPresets}
            capOverride={capOverrides[slotId]}
            isConfigured={isConfigured}
            isFirst={isConfigured && slotId === configuredSlots[0]}
            isDiscovered={discoveredSlotIds.includes(slotId)}
            isEditing={editingSlot === slotId}
            savingCapabilities={savingCapabilities}
            commitSlot={(next) => void commitSlot(next, slotId)}
            onToggleEditing={() =>
              setEditingSlot(editingSlot === slotId ? null : slotId)
            }
            onResetCapability={() => resetCapOverride(slotId)}
            onUpdateCapability={(patch) => updateCapOverride(slotId, patch)}
          />
        ))}
      </div>

      <div className="settings-group mt-2 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="settings-section-title flex items-center gap-1.5">
            <Database className="w-3 h-3" />
            {t("settings.modelDatabase")}
          </h3>
          <Button
            variant="outline"
            size="sm"
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
                  ? new Date(modelDbInfo.updatedAt).toLocaleDateString(
                      i18n.language,
                    )
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
