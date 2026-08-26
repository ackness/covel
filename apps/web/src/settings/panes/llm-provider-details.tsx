import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import {
  lookupModelCapabilityDetails,
  type ModelCapabilityLookupResult,
  type ProviderModelProfile,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { PingButton } from "@/components/shared/ping-button.js";
import { LlmKeysPane } from "./LlmKeysPane.js";
import type { ProviderCatalogEntry } from "./llm-provider-catalog.js";
import { ProtocolSelect } from "./llm-provider-dialogs.js";

export function ProviderDetails({
  provider,
  onAddModel,
  onPatchLocalProfile,
  onDeleteLocalModel,
  onDeleteLocalProvider,
}: {
  provider: ProviderCatalogEntry;
  onAddModel: () => void;
  onPatchLocalProfile: (patch: Partial<ProviderModelProfile>) => void;
  onDeleteLocalModel: (modelRef: string) => void;
  onDeleteLocalProvider: () => void;
}) {
  const { t } = useTranslation();
  const isServerProvider = provider.serverModels.length > 0;
  const localProfile = provider.localProfile;
  const committedBaseUrl = localProfile?.baseUrl ?? provider.baseUrl;
  const [baseUrlDraft, setBaseUrlDraft] = useState(committedBaseUrl);
  useEffect(() => {
    setBaseUrlDraft(committedBaseUrl);
  }, [committedBaseUrl, provider.id]);

  const commitBaseUrl = () => {
    if (localProfile && baseUrlDraft !== committedBaseUrl) {
      onPatchLocalProfile({ baseUrl: baseUrlDraft });
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
      />

      <div className="grid grid-cols-1 gap-2">
        <label className="space-y-1">
          <span className="text-[10px] text-muted-foreground">
            {t("settings.baseUrl", "API endpoint")}
          </span>
          <input
            value={baseUrlDraft}
            readOnly={!localProfile}
            onChange={(event) => setBaseUrlDraft(event.target.value)}
            onBlur={commitBaseUrl}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="w-full border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none read-only:bg-muted/30 read-only:text-muted-foreground focus:ring-1 focus:ring-primary"
          />
        </label>
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
              {t("settings.modelIds", "Model IDs")}
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
              modelId={model.model}
              presetId={model.id}
              source="server"
            />
          ))}
          {localProfile?.models.map((model) => (
            <ProviderModelRow
              key={model.ref}
              provider={provider.provider}
              modelId={model.modelId}
              presetId={model.ref}
              source="local"
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
  modelId,
  presetId,
  source,
  onDelete,
}: {
  provider: string;
  modelId: string;
  presetId: string;
  source: "server" | "local";
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 px-2.5 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs" title={modelId}>
            {modelId}
          </div>
          <ModelCapabilitySummary provider={provider} modelId={modelId} />
        </div>
        <Badge variant="outline" className="shrink-0 text-[9px]">
          {source === "server"
            ? t("settings.fromLlmToml", "llm.toml")
            : t("settings.localModel", "Local model")}
        </Badge>
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
      <PingButton target={{ kind: "preset", presetId }} />
    </div>
  );
}

function ModelCapabilitySummary({
  provider,
  modelId,
}: {
  provider: string;
  modelId: string;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<ModelCapabilityLookupResult | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    lookupModelCapabilityDetails(modelId, provider)
      .then((value) => {
        if (active) setResult(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [modelId, provider]);

  if (!result) {
    return <div className="mt-0.5 text-[9px] text-muted-foreground">…</div>;
  }
  const supportsImage = result.capability.input.includes("image");
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[9px] text-muted-foreground">
      <span>
        {result.matchedModelId ??
          t("settings.capabilityEstimatedShort", "Protocol defaults")}
      </span>
      {supportsImage && (
        <span>{t("settings.modalInImage", "Image input")}</span>
      )}
      {result.capability.contextWindow && (
        <span>{result.capability.contextWindow.toLocaleString()} ctx</span>
      )}
    </div>
  );
}
