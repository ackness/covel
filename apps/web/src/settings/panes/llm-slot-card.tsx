import { defaultModelRoleTag } from "@covel/shared";
import { isRoleModelCompatible, modelRoleTag } from "@/lib/model-role.js";
import { formatModelConfigLabel } from "@/lib/model-config-label.js";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Pencil, RotateCw } from "lucide-react";
import {
  slotBindingKey,
  type LlmSlotInfo,
  type SlotConfigEntry,
  type ModelCapabilityInfo,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { CapabilityEditor } from "./llm-capability-controls.js";
import { LlmAdvancedPane } from "./LlmAdvancedPane.js";
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
  catalogRevision?: string;
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
  catalogRevision,
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
  const [editingParameters, setEditingParameters] = useState(false);
  const selectedKey = slotBindingKey(slotConfig[slotId]) ?? "";
  const candidateKey = (preset: (typeof allPresets)[number]) =>
    slotBindingKey(
      preset.isCustom ? { modelRef: preset.id } : { presetId: preset.id },
    );
  const selectedPreset = allPresets.find(
    (preset) => candidateKey(preset) === selectedKey,
  );
  const missingBinding = !!selectedKey && !selectedPreset;
  const roleTag = modelRoleTag(
    slotId,
    serverSlot?.tag,
    selectedPreset
      ? {
          ...selectedPreset,
          ...(capOverride?.output
            ? { capability: { output: capOverride.output } }
            : {}),
        }
      : undefined,
  );
  const requiredTag = serverSlot?.tag ?? defaultModelRoleTag(slotId);
  const supportsRole = (preset: (typeof allPresets)[number]) =>
    !requiredTag ||
    isRoleModelCompatible(
      {
        ...preset,
        ...(capOverride?.output
          ? { capability: { output: capOverride.output } }
          : {}),
      },
      requiredTag,
    );
  const incompatibleBinding = !!selectedPreset && !supportsRole(selectedPreset);
  const compatiblePresets = allPresets.filter(supportsRole);
  const target = resolveEffectiveModelTarget(
    selectedPreset,
    missingBinding ? undefined : serverSlot,
  );
  const lookup = useModelCapability(
    target.model,
    target.provider,
    target.protocol,
    catalogRevision,
  );
  const {
    provider: effectiveProvider,
    model: effectiveModel,
    protocol: effectiveProtocol,
  } = target;
  const providerChoices = Array.from(
    new Set(
      [
        ...compatiblePresets.map((preset) => preset.provider),
        effectiveProvider,
        serverSlot?.provider,
      ].filter(Boolean),
    ),
  );
  const modelChoices =
    missingBinding || incompatibleBinding
      ? { presets: compatiblePresets, includesServerBase: !!serverSlot }
      : createProviderScopedModelChoices({
          provider: effectiveProvider,
          presets: compatiblePresets,
          serverSlot,
        });
  const isRequired = !isConfigured && slotId === "default";
  const isVirtualSlot = isDiscovered && !serverSlot;
  const hasCapOverride = !!capOverride;

  return (
    <div
      key={slotId}
      role="group"
      aria-label={slotId}
      className="border border-border p-3 space-y-2"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{slotId}</span>
        {(requiredTag || selectedPreset) && (
          <Badge variant="outline">{roleTag}</Badge>
        )}
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
          {((selectedPreset && serverSlot) ||
            missingBinding ||
            incompatibleBinding) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={() => {
                const updated = { ...slotConfig };
                delete updated[slotId];
                commitSlot(updated);
              }}
              title={
                serverSlot
                  ? t("settings.useLlmTomlDefault", {
                      provider: serverSlot.provider,
                      model: serverSlot.model,
                    })
                  : t("settings.resetOverride")
              }
            >
              <RotateCw className="mr-0.5 h-3 w-3" />
              {t("settings.resetOverride")}
            </Button>
          )}
        </div>
      </div>

      {(missingBinding || incompatibleBinding) && (
        <p role="alert" className="text-xs text-destructive">
          {t(
            incompatibleBinding
              ? "settings.modelBindingIncompatible"
              : "settings.modelBindingMissing",
          )}
        </p>
      )}

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
                  presets: compatiblePresets,
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
            {t("settings.modelConfiguration")}
          </span>
          <select
            value={
              selectedPreset || missingBinding || incompatibleBinding
                ? selectedKey
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
              const candidate = compatiblePresets.find(
                (preset) => candidateKey(preset) === value,
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
            {(missingBinding || incompatibleBinding) && (
              <option value={selectedKey} disabled>
                {t(
                  incompatibleBinding
                    ? "settings.modelBindingIncompatible"
                    : "settings.modelBindingMissing",
                )}
              </option>
            )}
            {modelChoices.includesServerBase && serverSlot && (
              <option value="__base">
                {t("settings.useDefault")} ·{" "}
                {formatModelConfigLabel(serverSlot)}
              </option>
            )}
            {!modelChoices.includesServerBase &&
              modelChoices.presets.length === 0 && (
                <option value="">
                  {t("settings.addModelFirst", "Add a model first")}
                </option>
              )}
            {modelChoices.presets.map((preset) => (
              <option key={candidateKey(preset)} value={candidateKey(preset)}>
                {formatModelConfigLabel(preset)}
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
          {t("settings.protocolLabel", {
            protocol: effectiveProtocol,
            defaultValue: "Protocol: {{protocol}}",
          })}
        </span>
      </div>

      <p className="text-[11px] text-muted-foreground break-all">
        {selectedPreset?.isCustom
          ? t("settings.localModel")
          : t("settings.fromLlmToml")}
        {target.baseUrl ? ` · ${target.baseUrl}` : ""}
      </p>

      {effectiveModel && !incompatibleBinding && (
        <ResolvedCapability
          lookup={lookup}
          provider={effectiveProvider}
          baseCapability={target.baseCapability}
          override={capOverride}
        />
      )}

      {effectiveModel && !incompatibleBinding && (
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

      {effectiveModel && isEditing && (
        <CapabilityEditor
          serverCap={resolveDisplayCapability(lookup, target.baseCapability)}
          override={capOverride}
          onUpdate={onUpdateCapability}
        />
      )}
      {effectiveModel && !incompatibleBinding && roleTag === "text" && (
        <div className="space-y-2 border-t border-border pt-2">
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            aria-expanded={editingParameters}
            onClick={() => setEditingParameters((value) => !value)}
          >
            {t(
              "settings.editGenerationParameters",
              "Generation parameters (tokens, temperature, reasoning)",
            )}
          </Button>
          {editingParameters && (
            <LlmAdvancedPane
              slotId={slotId}
              catalogRevision={catalogRevision}
            />
          )}
        </div>
      )}
    </div>
  );
}
