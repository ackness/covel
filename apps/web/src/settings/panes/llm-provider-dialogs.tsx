import { useEffect, useState } from "react";
import { describeProviderFailure } from "@/lib/provider-failure-hint.js";
import {
  fetchProviderProtocols,
  listProviderModels,
  type ReasoningEffort,
} from "@/services/api.js";
import {
  PROVIDER_PROTOCOL_DESCRIPTORS,
  getBuiltinProviderConnection,
  listBuiltinProviderConnections,
  protocolOutputModalities,
  type ProviderProtocolDescriptor,
  type ProviderProtocolOutput,
} from "@covel/shared";
import { ImportedModelReasoning } from "./model-reasoning-settings.js";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  normalizeProviderId,
  parseModelIds,
  type ProviderDraft,
} from "./llm-provider-catalog.js";

export function ProviderDialog({
  open,
  busy,
  error,
  draft,
  onOpenChange,
  onDraftChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  draft: ProviderDraft;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (draft: ProviderDraft) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const typedProviderId = draft.providerId.trim().toLowerCase();
  const knownProviderId = getBuiltinProviderConnection(typedProviderId)
    ? typedProviderId
    : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.addProvider", "Add provider")}</DialogTitle>
          <DialogDescription>
            {t(
              "settings.addProviderHint",
              "Configure the provider connection once and add one or more model IDs.",
            )}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <label className="block space-y-1 text-xs">
            <span>{t("settings.providerPreset")}</span>
            <select
              value={knownProviderId}
              onChange={(event) => {
                const connection = getBuiltinProviderConnection(
                  event.target.value,
                );
                onDraftChange({
                  ...draft,
                  providerId: event.target.value,
                  baseUrl: connection?.baseUrl ?? "",
                  protocol: "",
                });
              }}
              className="w-full border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">{t("settings.providerPresetCustom")}</option>
              {(["cloud", "local"] as const).map((kind) => (
                <optgroup
                  key={kind}
                  label={t(
                    kind === "local"
                      ? "settings.providerPresetLocal"
                      : "settings.providerPresetCloud",
                  )}
                >
                  {listBuiltinProviderConnections()
                    .filter(
                      (connection) =>
                        (connection.local === true) === (kind === "local"),
                    )
                    .map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          <input
            value={draft.providerId}
            onChange={(event) =>
              onDraftChange({ ...draft, providerId: event.target.value })
            }
            placeholder={t("settings.providerIdExample")}
            className="w-full border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            value={draft.baseUrl}
            onChange={(event) =>
              onDraftChange({ ...draft, baseUrl: event.target.value })
            }
            placeholder={t("settings.baseUrlPlaceholder")}
            className="w-full border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          <ProtocolSelect
            provider={draft.providerId}
            inheritLabel={t("settings.providerProtocolDefault")}
            value={draft.protocol}
            onChange={(protocol) => onDraftChange({ ...draft, protocol })}
          />
          <ModelIdsTextarea
            value={draft.modelIds}
            onChange={(modelIds) => onDraftChange({ ...draft, modelIds })}
            listTarget={modelListTarget(
              draft.providerId,
              draft.baseUrl,
              draft.protocol,
            )}
          />
          <ImportedModelReasoning
            modelIds={draft.modelIds}
            provider={draft.providerId}
            protocol={draft.protocol}
            values={draft.reasoningDefaults ?? {}}
            onChange={(reasoningDefaults) =>
              onDraftChange({ ...draft, reasoningDefaults })
            }
          />
          <Button
            onClick={onSubmit}
            disabled={
              !draft.providerId.trim() ||
              parseModelIds(draft.modelIds).length === 0
            }
          >
            <Plus className="h-3.5 w-3.5" />
            {t("settings.addProvider", "Add provider")}
          </Button>
        </fieldset>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ModelDialog({
  open,
  busy,
  error,
  providerId,
  provider,
  baseUrl,
  protocol,
  modelProtocol,
  onProtocolChange,
  reasoningDefaults,
  onReasoningChange,
  value,
  onOpenChange,
  onChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  providerId: string;
  provider?: string;
  baseUrl?: string;
  protocol?: string;
  modelProtocol: string;
  onProtocolChange: (value: string) => void;
  reasoningDefaults: Record<string, ReasoningEffort | undefined>;
  onReasoningChange: (
    values: Record<string, ReasoningEffort | undefined>,
  ) => void;
  value: string;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const count = parseModelIds(value).length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.addModel", "Add model")}</DialogTitle>
          <DialogDescription>
            {t("settings.addModelsToProvider", {
              provider: providerId,
              defaultValue:
                "Add model IDs to {{provider}}. IDs are sent unchanged.",
            })}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <ModelIdsTextarea
            value={value}
            onChange={onChange}
            listTarget={modelListTarget(
              providerId,
              baseUrl,
              modelProtocol || protocol,
            )}
          />
          <ProtocolSelect
            provider={provider ?? providerId}
            inheritedProtocol={protocol}
            value={modelProtocol}
            onChange={onProtocolChange}
            inheritLabel={t("settings.inheritProviderProtocol")}
          />
          <ImportedModelReasoning
            modelIds={value}
            provider={providerId}
            protocol={modelProtocol || protocol}
            values={reasoningDefaults}
            onChange={onReasoningChange}
          />
          <Button onClick={onSubmit} disabled={count === 0}>
            <Plus className="h-3.5 w-3.5" />
            {t("settings.addModelsCount", {
              count,
              defaultValue: "Add {{count}} models",
            })}
          </Button>
        </fieldset>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ModelIdsTextarea({
  value,
  onChange,
  listTarget,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The endpoint to read a model list from; absent when it cannot list. */
  listTarget?: { provider: string; baseUrl?: string; protocol?: string };
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className="text-xs font-medium">
          {t("settings.modelIds", "Model IDs")}
        </span>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={6}
          placeholder={"openai/gpt-5.6-sol\ndeepseek/deepseek-v4-flash"}
          className="w-full resize-y border border-border bg-background px-3 py-2 font-mono text-sm leading-relaxed outline-none focus:ring-1 focus:ring-primary"
        />
        <span className="block text-[10px] text-muted-foreground">
          {t(
            "settings.modelIdsPerLineHint",
            "Enter one model ID per line. Empty lines and duplicates are ignored.",
          )}
        </span>
      </label>
      {listTarget && (
        <ModelListPicker
          target={listTarget}
          value={value}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/** Reads the endpoint's own model list so the IDs need not be typed. */
function ModelListPicker({
  target,
  value,
  onChange,
}: {
  target: { provider: string; baseUrl?: string; protocol?: string };
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const selected = new Set(parseModelIds(value));
  const shown = (models ?? []).filter((id) =>
    id.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listProviderModels(target);
      setModels(result.ok ? result.models : null);
      if (!result.ok)
        setError(
          describeProviderFailure(t, result.errorKind, result.error) ??
            t("settings.fetchModelsFailed"),
        );
    } catch (cause) {
      setModels(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next].join("\n"));
  };
  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={loading || !target.provider.trim()}
        onClick={() => void load()}
        className="text-[11px]"
      >
        {t("settings.fetchModels")}
      </Button>
      {error && (
        <p role="alert" className="text-[10px] text-destructive">
          {error}
        </p>
      )}
      {models && models.length === 0 && (
        <p className="text-[10px] text-muted-foreground">
          {t("settings.fetchModelsEmpty")}
        </p>
      )}
      {models && models.length > 0 && (
        <div className="space-y-1 border border-border p-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("settings.fetchModelsFilter")}
            aria-label={t("settings.fetchModelsFilter")}
            className="w-full border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <ul className="max-h-40 overflow-y-auto">
            {shown.map((id) => (
              <li key={id}>
                <label className="flex items-center gap-2 py-0.5 font-mono text-xs">
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    onChange={() => toggle(id)}
                  />
                  <span className="break-all">{id}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** An evaluation protocol has no model list to read. */
function modelListTarget(
  providerId: string,
  baseUrl: string | undefined,
  protocol: string | undefined,
): { provider: string; baseUrl?: string; protocol?: string } | undefined {
  const provider = normalizeProviderId(providerId);
  if (!provider || protocolOutputModalities(protocol).includes("evaluation"))
    return undefined;
  return {
    provider,
    ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(protocol ? { protocol } : {}),
  };
}

/** The built-in protocols, then those of loaded plugins once the server answers. */
function useProviderProtocols(): readonly ProviderProtocolDescriptor[] {
  const [protocols, setProtocols] = useState<
    readonly ProviderProtocolDescriptor[]
  >(PROVIDER_PROTOCOL_DESCRIPTORS);
  useEffect(() => {
    let current = true;
    void fetchProviderProtocols().then((list) => {
      if (current) setProtocols(list);
    });
    return () => {
      current = false;
    };
  }, []);
  return protocols;
}

function protocolOptions(
  protocols: readonly ProviderProtocolDescriptor[],
  output: ProviderProtocolOutput,
) {
  return protocols
    .filter((descriptor) => descriptor.output === output)
    .map((descriptor) => (
      <option key={descriptor.id} value={descriptor.id}>
        {descriptor.label}
      </option>
    ));
}

export function ProtocolSelect({
  value,
  onChange,
  disabled = false,
  inheritLabel,
  provider,
  inheritedProtocol,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inheritLabel?: string;
  provider?: string;
  inheritedProtocol?: string;
}) {
  const { t } = useTranslation();
  const protocols = useProviderProtocols();
  const evaluation = protocolOutputModalities(value).includes("evaluation");
  const selectEvaluation = () =>
    inheritedProtocol &&
    protocolOutputModalities(inheritedProtocol).includes("evaluation")
      ? inheritedProtocol
      : (getBuiltinProviderConnection(provider ?? "")?.evaluationProtocol ??
        "typesafe-systemone-v1");
  const selectClassName =
    "w-full border border-border bg-background px-2 py-1.5 text-xs outline-none disabled:bg-muted/30 disabled:text-muted-foreground focus:ring-1 focus:ring-primary";
  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-xs">
        <span>{t("settings.protocol")}</span>
        <select
          value={evaluation ? "evaluation" : value}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.value === "evaluation"
                ? selectEvaluation()
                : event.target.value,
            )
          }
          className={selectClassName}
        >
          {inheritLabel && <option value="">{inheritLabel}</option>}
          {protocolOptions(protocols, "text")}
          <option value="evaluation">{t("settings.evaluationProtocol")}</option>
        </select>
      </label>
      {evaluation && (
        <div className="space-y-1 border-l border-border pl-3">
          <label className="block space-y-1 text-xs">
            <span>{t("settings.evaluationApi")}</span>
            <select
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              className={selectClassName}
            >
              {protocolOptions(protocols, "evaluation")}
            </select>
          </label>
          <p className="text-[10px] text-muted-foreground">
            {t("settings.evaluationApiHint")}
          </p>
        </div>
      )}
    </div>
  );
}
