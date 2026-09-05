import { useTranslation } from "react-i18next";
import { Pencil, RotateCw } from "lucide-react";
import {
  slotBindingId,
  type LlmSlotInfo,
  type SlotConfigEntry,
  type ModelCapabilityInfo,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { CapabilityEditor } from "./llm-capability-controls.js";
import { ResolvedCapability } from "./llm-resolved-capability.js";
import {
  resolveDisplayCapability,
  resolveEffectiveModelTarget,
} from "./llm-effective-capability.js";
import { useModelCapability } from "./use-model-capability.js";
import {
  bindSlotToProvider,
  createProviderScopedModelChoices,
  type collectLlmSlotPresetCandidates,
} from "./llm-slots-model.js";

interface LlmSlotCardProps {
  slotId: string;
  slotConfig: Record<string, SlotConfigEntry>;
  serverSlot: LlmSlotInfo | null | undefined;
  allPresets: ReturnType<typeof collectLlmSlotPresetCandidates>;
  capOverride: Partial<ModelCapabilityInfo> | undefined;
  isConfigured: boolean;
  isFirst: boolean;
  isDiscovered: boolean;
  isEditing: boolean;
  commitSlot: (next: Record<string, SlotConfigEntry>) => void;
  onToggleEditing: () => void;
  onResetCapability: () => void;
  onUpdateCapability: (patch: Partial<ModelCapabilityInfo>) => void;
}

export function LlmSlotCard({
  slotId,
  slotConfig,
  serverSlot,
  allPresets,
  capOverride,
  isConfigured,
  isFirst,
  isDiscovered,
  isEditing,
  commitSlot,
  onToggleEditing,
  onResetCapability,
  onUpdateCapability,
}: LlmSlotCardProps) {
  const { t } = useTranslation();
  const selectedPresetId = slotBindingId(slotConfig[slotId]) ?? "";
  const selectedPreset = allPresets.find((p) => p.id === selectedPresetId);
  const target = resolveEffectiveModelTarget(selectedPreset, serverSlot);
  const lookup = useModelCapability(
    target.model,
    target.provider,
    target.protocol,
  );
  const {
    provider: effectiveProvider,
    model: effectiveModel,
    protocol: effectiveProtocol,
  } = target;
  const providerChoices = Array.from(
    new Set(
      [
        ...allPresets.map((preset) => preset.provider),
        effectiveProvider,
      ].filter(Boolean),
    ),
  );
  const modelChoices = createProviderScopedModelChoices({
    provider: effectiveProvider,
    presets: allPresets,
    serverSlot,
  });
  const isRequired = !isConfigured && slotId === "default";
  const isVirtualSlot = isDiscovered && !serverSlot;
  const hasCapOverride = isConfigured && !!capOverride;

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
          {selectedPreset && serverSlot && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={() => {
                const updated = { ...slotConfig };
                delete updated[slotId];
                commitSlot(updated);
              }}
              title={t("settings.useLlmTomlDefault", {
                provider: serverSlot.provider,
                model: serverSlot.model,
              })}
            >
              <RotateCw className="mr-0.5 h-3 w-3" />
              {t("settings.resetOverride")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[10px] text-muted-foreground">
            {t("settings.providerLabel", "Provider")}
          </span>
          <select
            value={effectiveProvider}
            onChange={(event) => {
              commitSlot(
                bindSlotToProvider({
                  slotId,
                  provider: event.target.value,
                  slotConfig,
                  presets: allPresets,
                  serverSlot,
                }),
              );
            }}
            className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
          >
            {!effectiveProvider && (
              <option value="">
                {t("settings.selectProvider", "Select provider")}
              </option>
            )}
            {providerChoices.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[10px] text-muted-foreground">
            {t("settings.modelId", "Model ID")}
          </span>
          <select
            value={
              selectedPreset
                ? selectedPresetId
                : modelChoices.includesServerBase
                  ? "__base"
                  : ""
            }
            onChange={(event) => {
              const value = event.target.value;
              if (!value || value === "__base") {
                const updated = { ...slotConfig };
                delete updated[slotId];
                commitSlot(updated);
                return;
              }
              const candidate = allPresets.find(
                (preset) => preset.id === value,
              );
              if (!candidate) return;
              commitSlot({
                ...slotConfig,
                [slotId]: candidate.isCustom
                  ? { modelRef: candidate.id }
                  : { presetId: candidate.id },
              });
            }}
            className="w-full bg-background border border-border px-3 py-1.5 text-sm font-mono outline-none focus:ring-1 focus:ring-primary"
          >
            {modelChoices.includesServerBase && serverSlot && (
              <option value="__base">{serverSlot.model}</option>
            )}
            {!modelChoices.includesServerBase &&
              modelChoices.presets.length === 0 && (
                <option value="">
                  {t("settings.addModelFirst", "Add a model first")}
                </option>
              )}
            {modelChoices.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.model}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="text-xs text-muted-foreground grid grid-cols-1 sm:grid-cols-3 gap-1 wrap-anywhere">
        <span>
          {t("settings.providerLabel", "Provider")}: {effectiveProvider || "—"}
        </span>
        <span>
          {t("settings.modelLabel", "Model")}: {effectiveModel || "—"}
        </span>
        <span>
          {selectedPreset
            ? selectedPreset.isCustom
              ? t("settings.localModel", "Local model")
              : t("settings.configuredModel", "Configured model")
            : t("settings.protocolLabel", {
                protocol: (effectiveProtocol || "").replace("-v1", "") || "—",
                defaultValue: "Protocol: {{protocol}}",
              })}
        </span>
      </div>

      {effectiveModel && (
        <ResolvedCapability
          lookup={lookup}
          provider={effectiveProvider}
          baseCapability={target.baseCapability}
          override={capOverride}
        />
      )}

      {isConfigured && (
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] px-1.5"
            onClick={onToggleEditing}
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
              onClick={onResetCapability}
            >
              <RotateCw className="w-3 h-3 mr-0.5" />
              {t("settings.resetOverride")}
            </Button>
          )}
        </div>
      )}

      {isConfigured && isEditing && (
        <CapabilityEditor
          serverCap={resolveDisplayCapability(lookup, target.baseCapability)}
          override={capOverride}
          onUpdate={onUpdateCapability}
        />
      )}
    </div>
  );
}
