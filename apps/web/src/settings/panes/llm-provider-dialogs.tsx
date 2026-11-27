import { useEffect, useRef, useState } from "react";
import { describeProviderFailure } from "@/lib/provider-failure-hint.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { openPluginConfigFlow } from "@/lib/platform-ui-events.js";
import {
  fetchProviderProtocols,
  listProviderModels,
  type ProviderSourceSummary,
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
import { LocalModelEndpointNote } from "./local-model-endpoint-note.js";
import { useTranslation } from "react-i18next";
import { Plus, ShieldAlert } from "lucide-react";
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

const PLUGIN_SOURCE_PREFIX = "source:";

export function providerSourceStatusLabel(
  source: Pick<ProviderSourceSummary, "ready" | "reason">,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (source.ready) return t("settings.providerSourceReady");
  if (source.reason === "capability_denied") {
    return t("settings.providerSourceNeedsPermission", "Permission required");
  }
  return t("settings.providerSourceNotReady");
}

export function ProviderDialog({
  open,
  busy,
  error,
  draft,
  providerSources = [],
  onOpenPermissions,
  onOpenChange,
  onDraftChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  draft: ProviderDraft;
  providerSources?: readonly ProviderSourceSummary[];
  onOpenPermissions?: () => void;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (draft: ProviderDraft) => void;
  onSubmit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const typedProviderId = draft.providerId.trim().toLowerCase();
  const knownProviderId = getBuiltinProviderConnection(typedProviderId)
    ? typedProviderId
    : "";
  const selectedSource = draft.source
    ? providerSources.find((src) => src.id === draft.source)
    : undefined;
  const selectedPresetValue = draft.source
    ? `${PLUGIN_SOURCE_PREFIX}${draft.source}`
    : knownProviderId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ui-scroll max-h-[90dvh] max-w-3xl overflow-y-auto p-4 sm:p-6">
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
              value={selectedPresetValue}
              onChange={(event) => {
                const value = event.target.value;
                if (value.startsWith(PLUGIN_SOURCE_PREFIX)) {
                  const sourceId = value.slice(PLUGIN_SOURCE_PREFIX.length);
                  const src = providerSources.find(
                    (item) => item.id === sourceId,
                  );
                  if (!src) return;
                  const defaultAccount =
                    src.accounts.find((acc) => acc.isDefault)?.id ??
                    src.accounts[0]?.id;
                  const prevWasPresetOrSource =
                    !draft.providerId.trim() ||
                    Boolean(draft.source) ||
                    Boolean(knownProviderId);
                  onDraftChange({
                    ...draft,
                    source: src.id,
                    ...(defaultAccount
                      ? { account: defaultAccount }
                      : { account: undefined }),
                    providerId: prevWasPresetOrSource
                      ? normalizeProviderId(src.sourceId) || src.sourceId
                      : draft.providerId,
                    baseUrl: src.baseUrl,
                    protocol: src.protocol,
                  });
                  return;
                }
                const {
                  source: _removedSource,
                  account: _removedAccount,
                  ...rest
                } = draft;
                const connection = getBuiltinProviderConnection(value);
                onDraftChange({
                  ...rest,
                  providerId: value,
                  baseUrl: connection?.baseUrl ?? "",
                  protocol: "",
                });
              }}
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-xs outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">{t("settings.providerPresetCustom")}</option>
              {providerSources.length > 0 && (
                <optgroup
                  label={t(
                    "settings.providerPresetPlugin",
                    "Plugin providers",
                  )}
                >
                  {providerSources.map((src) => (
                    <option
                      key={src.id}
                      value={`${PLUGIN_SOURCE_PREFIX}${src.id}`}
                    >
                      {resolveDisplayText(src.label, locale)} (
                      {providerSourceStatusLabel(src, t)})
                    </option>
                  ))}
                </optgroup>
              )}
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
          {selectedSource && !selectedSource.ready && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              <div className="flex min-w-0 items-start gap-2">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <p className="text-muted-foreground leading-relaxed">
                  {selectedSource.reason === "capability_denied"
                    ? t("settings.providerSourcePermissionHint", {
                        plugin: selectedSource.pluginId,
                        defaultValue:
                          "Plugin {{plugin}} does not yet have instance-scope and provider-source permissions. Approve its requested capabilities in Permissions & Security first.",
                      })
                    : t("settings.providerSourceSignInHint", {
                        defaultValue:
                          "This provider source requires authentication before its credentials can be used.",
                      })}
                </p>
              </div>
              {selectedSource.reason === "capability_denied" &&
                onOpenPermissions && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onOpenPermissions}
                  >
                    {t(
                      "settings.providerSourceOpenPermissions",
                      "Open Permissions & Security",
                    )}
                  </Button>
                )}
              {selectedSource.reason !== "capability_denied" &&
                selectedSource.authFlows.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      openPluginConfigFlow(
                        selectedSource.pluginId,
                        selectedSource.authFlows[0]!,
                      )
                    }
                  >
                    {t("settings.providerSourceSignIn")}
                  </Button>
                )}
            </div>
          )}
          {selectedSource && selectedSource.accounts.length > 0 && (
            <ProviderSourceAccountSelect
              accounts={selectedSource.accounts}
              value={draft.account ?? ""}
              onChange={(account) => onDraftChange({ ...draft, account })}
            />
          )}
          <label className="block space-y-1 text-xs">
            <span>{t("settings.providerIdLabel")}</span>
            <input
              value={draft.providerId}
              onChange={(event) =>
                onDraftChange({ ...draft, providerId: event.target.value })
              }
              placeholder={t("settings.providerIdExample")}
              className="w-full border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span>{t("settings.baseUrl")}</span>
            <input
              value={draft.baseUrl}
              readOnly={Boolean(draft.source)}
              onChange={(event) =>
                onDraftChange({ ...draft, baseUrl: event.target.value })
              }
              placeholder={t("settings.baseUrlPlaceholder")}
              className="w-full border border-border bg-background px-3 py-2 font-mono text-sm outline-none read-only:text-muted-foreground focus:ring-1 focus:ring-primary"
            />
          </label>
          <ProtocolSelect
            provider={draft.providerId}
            inheritLabel={t("settings.providerProtocolDefault")}
            value={draft.protocol}
            onChange={(protocol) => onDraftChange({ ...draft, protocol })}
          />
          {draft.source ? (
            <p className="text-[11px] text-muted-foreground">
              {t("settings.providerSourceManagedCredentials", {
                source: draft.source,
              })}
            </p>
          ) : (
            <LocalModelEndpointNote
              baseUrl={
                draft.baseUrl.trim() ||
                getBuiltinProviderConnection(typedProviderId)?.baseUrl ||
                ""
              }
              provider={typedProviderId}
            />
          )}
          <ModelIdsTextarea
            value={draft.modelIds}
            onChange={(modelIds) => onDraftChange({ ...draft, modelIds })}
            listTarget={modelListTarget(
              draft.providerId,
              draft.baseUrl,
              draft.protocol,
              draft.source,
              draft.account,
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
  source,
  account,
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
  source?: string;
  account?: string;
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
      <DialogContent className="ui-scroll max-h-[90dvh] max-w-2xl overflow-y-auto p-4 sm:p-6">
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
              source,
              account,
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
  listTarget?: {
    provider: string;
    source?: string;
    account?: string;
    baseUrl?: string;
    protocol?: string;
  };
}) {
  const { t } = useTranslation();
  const targetKey = JSON.stringify(listTarget);
  const previousTarget = useRef(targetKey);
  const picked = useRef(new Set<string>());
  useEffect(() => {
    if (previousTarget.current === targetKey) return;
    previousTarget.current = targetKey;
    const next = parseModelIds(value).filter((id) => !picked.current.has(id));
    if (picked.current.size > 0) onChange(next.join("\n"));
    picked.current.clear();
  }, [targetKey, value, onChange]);
  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className="text-xs font-medium">
          {t("settings.modelIds", "Model IDs")}
        </span>
        <textarea
          value={value}
          onChange={(event) => {
            const remaining = new Set(parseModelIds(event.target.value));
            for (const id of picked.current)
              if (!remaining.has(id)) picked.current.delete(id);
            onChange(event.target.value);
          }}
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
          key={JSON.stringify(listTarget)}
          target={listTarget}
          value={value}
          onChange={(next) => {
            const existing = new Set(parseModelIds(value));
            const nextIds = new Set(parseModelIds(next));
            for (const id of nextIds)
              if (!existing.has(id)) picked.current.add(id);
            for (const id of picked.current)
              if (!nextIds.has(id)) picked.current.delete(id);
            onChange(next);
          }}
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
  target: {
    provider: string;
    source?: string;
    account?: string;
    baseUrl?: string;
    protocol?: string;
  };
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
        disabled={loading || (!target.provider.trim() && !target.source)}
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
  source?: string,
  account?: string,
):
  | {
      provider: string;
      source?: string;
      account?: string;
      baseUrl?: string;
      protocol?: string;
    }
  | undefined {
  const provider = normalizeProviderId(providerId);
  if (
    (!provider && !source) ||
    protocolOutputModalities(protocol).includes("evaluation")
  )
    return undefined;
  return {
    provider: provider || source || "",
    ...(source ? { source } : {}),
    ...(account ? { account } : {}),
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

export function ProviderSourceAccountSelect({
  accounts,
  value,
  disabled = false,
  onChange,
  labelTextClassName,
  selectClassName = "w-full border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary",
}: {
  readonly accounts: ProviderSourceSummary["accounts"];
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: (account: string | undefined) => void;
  readonly labelTextClassName?: string;
  readonly selectClassName?: string;
}) {
  const { t } = useTranslation();
  return (
    <label className="block space-y-1 text-xs">
      <span className={labelTextClassName}>
        {t("settings.providerSourceAccount")}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
        className={selectClassName}
      >
        <option value="">{t("settings.providerSourceDefaultAccount")}</option>
        {accounts.map((acc) => (
          <option key={acc.id} value={acc.id}>
            {acc.label ?? acc.id}
          </option>
        ))}
      </select>
    </label>
  );
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
    "h-9 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm font-normal outline-none disabled:bg-muted/30 disabled:text-muted-foreground focus:ring-1 focus:ring-primary";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label className="flex min-w-0 flex-col gap-1.5 text-[13px] font-medium">
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
