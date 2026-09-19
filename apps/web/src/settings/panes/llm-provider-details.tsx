import { useTranslation } from "react-i18next";
import { Copy, Plus, Trash2 } from "lucide-react";
import {
  type ModelCapabilityInfo,
  type ProviderModelProfile,
  type ProviderModelEntry,
  type ReasoningEffort,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { PingButton } from "@/components/shared/ping-button.js";
import { LlmKeysPane } from "./LlmKeysPane.js";
import type { ProviderCatalogEntry } from "./llm-provider-catalog.js";
import { ProtocolSelect } from "./llm-provider-dialogs.js";
import { useModelCapability } from "./use-model-capability.js";
import { resolveDisplayCapability } from "./llm-effective-capability.js";
import { ModelReasoningSettings } from "./model-reasoning-settings.js";
import {
  SettingsDraftConflict,
  useSettingDraft,
} from "../use-setting-draft.js";

export function ProviderDetails({
  provider,
  onAddModel,
  onPatchLocalProfile,
  onDeleteLocalModel,
  onDuplicateLocalModel,
  onDeleteLocalProvider,
}: {
  provider: ProviderCatalogEntry;
  onAddModel: () => void;
  onPatchLocalProfile: (patch: Partial<ProviderModelProfile>) => void;
  onDeleteLocalModel: (modelRef: string) => void;
  onDuplicateLocalModel: (model: ProviderModelEntry) => void;
  onDeleteLocalProvider: () => void;
}) {
  const { t } = useTranslation();
  const isServerProvider = provider.serverModels.length > 0;
  const localProfile = provider.localProfile;
  const committedBaseUrl = localProfile?.baseUrl ?? provider.baseUrl;
  const baseUrl = useSettingDraft(committedBaseUrl, provider.id);

  const commitBaseUrl = () => {
    if (localProfile && !baseUrl.conflict) {
      const next = baseUrl.draft.trim();
      baseUrl.setDraft(next);
      if (next !== committedBaseUrl) onPatchLocalProfile({ baseUrl: next });
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="truncate font-mono text-base font-semibold">
              {provider.id}
            </h4>
            <Badge variant="outline" className="text-[9px]">
              {isServerProvider
                ? t("settings.fromLlmToml", "llm.toml")
                : t("settings.localProvider", "Local")}
            </Badge>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t("settings.modelIdOpaqueHint")}
          </p>
        </div>
        {localProfile && !isServerProvider && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDeleteLocalProvider}
            aria-label={t("common.delete", "Delete")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <LlmKeysPane
        key={provider.id}
        providerId={provider.id}
        showIntro={false}
        showPresetTests={false}
      />

      <div className="grid grid-cols-1 gap-2">
        <label className="space-y-1">
          <span className="text-[10px] text-muted-foreground">
            {t("settings.baseUrl", "API endpoint")}
          </span>
          <input
            value={baseUrl.draft}
            aria-invalid={baseUrl.conflict}
            readOnly={!localProfile}
            onChange={(event) => baseUrl.setDraft(event.target.value)}
            onBlur={commitBaseUrl}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="w-full border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none read-only:bg-muted/30 read-only:text-muted-foreground focus:ring-1 focus:ring-primary"
          />
        </label>
        {baseUrl.conflict && <SettingsDraftConflict onReload={baseUrl.reset} />}
        <label className="space-y-1">
          <span className="text-[10px] text-muted-foreground">
            {t("settings.protocol", "API protocol")}
          </span>
          <ProtocolSelect
            value={localProfile?.protocol ?? provider.protocol}
            disabled={!localProfile}
            onChange={(protocol) => onPatchLocalProfile({ protocol })}
          />
        </label>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h5 className="text-xs font-semibold">
              {t("settings.modelConfigurations")}
            </h5>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {t(
                "settings.providerModelsHint",
                "All models below share this provider connection and price multiplier.",
              )}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onAddModel}>
            <Plus className="h-3.5 w-3.5" />
            {t("settings.addModel", "Add model")}
          </Button>
        </div>

        <div className="divide-y divide-border border border-border">
          {provider.serverModels.map((model) => (
            <ProviderModelRow
              key={`server:${model.id}`}
              provider={provider.provider}
              protocol={model.protocol ?? provider.protocol}
              modelId={model.model}
              name={model.name}
              presetId={model.id}
              capability={model.capability}
              source="server"
            />
          ))}
          {localProfile?.models.map((model) => (
            <ProviderModelRow
              key={model.ref}
              provider={provider.provider}
              protocol={
                model.protocol ?? localProfile.protocol ?? provider.protocol
              }
              modelProtocol={model.protocol}
              onProtocolChange={(protocol) =>
                onPatchLocalProfile({
                  models: localProfile.models.map((entry) =>
                    entry.ref === model.ref ? { ...entry, protocol } : entry,
                  ),
                })
              }
              modelId={model.modelId}
              name={model.name}
              presetId={model.ref}
              source="local"
              reasoningEffort={model.reasoningEffort}
              onNameChange={(name) =>
                onPatchLocalProfile({
                  models: localProfile.models.map((entry) =>
                    entry.ref === model.ref ? { ...entry, name } : entry,
                  ),
                })
              }
              onDuplicate={() => onDuplicateLocalModel(model)}
              onReasoningChange={(reasoningEffort) =>
                onPatchLocalProfile({
                  models: localProfile.models.map((entry) =>
                    entry.ref === model.ref
                      ? { ...entry, reasoningEffort }
                      : entry,
                  ),
                })
              }
              onDelete={() => onDeleteLocalModel(model.ref)}
            />
          ))}
          {provider.serverModels.length === 0 &&
            (localProfile?.models.length ?? 0) === 0 && (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                {t("settings.noModels", "No models yet")}
              </div>
            )}
        </div>
      </section>
    </div>
  );
}

function ProviderModelRow({
  provider,
  protocol,
  modelProtocol,
  onProtocolChange,
  modelId,
  name,
  presetId,
  source,
  capability,
  onDelete,
  reasoningEffort,
  onReasoningChange,
  onNameChange,
  onDuplicate,
}: {
  provider: string;
  protocol: string;
  modelProtocol?: string;
  onProtocolChange?: (value: string | undefined) => void;
  modelId: string;
  name?: string;
  presetId: string;
  source: "server" | "local";
  capability?: ModelCapabilityInfo;
  onDelete?: () => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningChange?: (value: ReasoningEffort | undefined) => void;
  onNameChange?: (value: string) => void;
  onDuplicate?: () => void;
}) {
  const { t } = useTranslation();
  const nameDraft = useSettingDraft(name ?? "", presetId);
  return (
    <div
      role="group"
      aria-label={name || modelId}
      className="space-y-2 px-2.5 py-2"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs" title={modelId}>
            {name || modelId}
          </div>
          {name && name !== modelId && (
            <div
              className="truncate font-mono text-[10px] text-muted-foreground"
              title={modelId}
            >
              {modelId}
            </div>
          )}
          <ModelCapabilitySummary
            provider={provider}
            modelId={modelId}
            protocol={protocol}
            baseCapability={capability}
          />
        </div>
        <Badge variant="outline" className="shrink-0 text-[9px]">
          {source === "server"
            ? t("settings.fromLlmToml", "llm.toml")
            : t("settings.localModel", "Local model")}
        </Badge>
        {onDuplicate && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDuplicate}
            aria-label={t("settings.duplicateModelConfiguration")}
            title={t("settings.duplicateModelConfiguration")}
          >
            <Copy className="h-3 w-3" />
          </Button>
        )}
        {onDelete && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDelete}
            aria-label={t("common.delete", "Delete")}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
      {onProtocolChange && (
        <label className="block space-y-1 text-xs">
          <span>{t("settings.protocol")}</span>
          <ProtocolSelect
            value={modelProtocol ?? ""}
            onChange={(value) => onProtocolChange(value || undefined)}
            inheritLabel={t("settings.inheritProviderProtocol")}
          />
        </label>
      )}
      {onReasoningChange && (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t("settings.modelReasoningDefault")} ·{" "}
            {t(
              reasoningEffort
                ? `settings.reasoningLevel.${reasoningEffort}`
                : "settings.reasoningTaskDefault",
            )}
          </summary>
          <div className="mt-2 space-y-2">
            {onNameChange && (
              <label className="block space-y-1 text-xs">
                <span>{t("settings.modelConfigurationName")}</span>
                <input
                  value={nameDraft.draft}
                  placeholder={modelId}
                  maxLength={100}
                  aria-invalid={nameDraft.conflict}
                  onChange={(event) => nameDraft.setDraft(event.target.value)}
                  onBlur={() => {
                    if (!nameDraft.conflict) {
                      const next = nameDraft.draft.trim();
                      nameDraft.setDraft(next);
                      if (next !== (name ?? "")) onNameChange(next);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  className="w-full border border-border bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
            )}
            {nameDraft.conflict && (
              <SettingsDraftConflict onReload={nameDraft.reset} />
            )}
            <ModelReasoningSettings
              model={modelId}
              provider={provider}
              protocol={protocol}
              value={reasoningEffort}
              onChange={onReasoningChange}
            />
          </div>
        </details>
      )}
      <PingButton
        target={
          source === "local"
            ? { kind: "model", modelRef: presetId }
            : { kind: "preset", presetId }
        }
      />
    </div>
  );
}

function ModelCapabilitySummary({
  provider,
  modelId,
  protocol,
  baseCapability,
}: {
  provider: string;
  modelId: string;
  protocol: string;
  baseCapability?: ModelCapabilityInfo;
}) {
  const { t } = useTranslation();
  const result = useModelCapability(modelId, provider, protocol);
  const capability = resolveDisplayCapability(result, baseCapability);

  if (result === undefined && !capability) {
    return <div className="mt-0.5 text-[9px] text-muted-foreground">…</div>;
  }
  const supportsImage = capability?.input.includes("image");
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[9px] text-muted-foreground">
      <span>
        {result?.found
          ? result.matchedModelId
          : capability?.contextWindow || capability?.maxOutputTokens
            ? null
            : t("settings.modelLimitsUnknown", {
                defaultValue: "Model limits unknown",
              })}
      </span>
      {capability?.output.includes("evaluation") && (
        <span>{t("settings.modalOutEvaluation")}</span>
      )}
      {supportsImage && (
        <span>{t("settings.modalInImage", "Image input")}</span>
      )}
      {capability?.contextWindow && (
        <span>{capability.contextWindow.toLocaleString()} ctx</span>
      )}
    </div>
  );
}
