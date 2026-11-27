import { SettingsListFilter, SettingsListSearch } from "../list-controls.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { useEffect, useState } from "react";
import { useSettingsWritable } from "../use-settings-save.js";
import { useTranslation } from "react-i18next";
import { ChevronRight, Copy, FileCode, Plus, Trash2 } from "lucide-react";
import {
  type LlmConfigResponse,
  type ModelCapabilityInfo,
  type ProviderModelProfile,
  type ProviderModelEntry,
  type ProviderSourceSummary,
  type ReasoningEffort,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { PingButton } from "@/components/shared/ping-button.js";
import { isDesktopApp } from "@/lib/desktop-bridge.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { openPluginConfigFlow } from "@/lib/platform-ui-events.js";
import { SHARED_SERVER_DOCS_PAGE, docsPageUrl } from "@/lib/docs-links.js";
import { getSharedServerInfo } from "@/services/api/health.js";
import { LlmKeysPane } from "./LlmKeysPane.js";
import { LocalModelEndpointNote } from "./local-model-endpoint-note.js";
import type { ProviderCatalogEntry } from "./llm-provider-catalog.js";
import {
  ProtocolSelect,
  ProviderSourceAccountSelect,
  providerSourceStatusLabel,
} from "./llm-provider-dialogs.js";
import { useModelCapability } from "./use-model-capability.js";
import { resolveDisplayCapability } from "./llm-effective-capability.js";
import { ModelReasoningSettings } from "./model-reasoning-settings.js";
import {
  SettingsDraftConflict,
  useSettingDraft,
} from "../use-setting-draft.js";
import { useOpenLlmToml } from "../use-open-llm-toml.js";
import { SettingsHelp } from "../pane-layout.js";

type ServerConfigSource = LlmConfigResponse["source"];

export function ProviderDetails({
  provider,
  serverConfig,
  builtinDefault = serverConfig?.kind === "builtin",
  providerSources = [],
  onOpenPermissions,
  busy = false,
  onAddModel,
  onPatchLocalProfile,
  onDeleteLocalModel,
  onDuplicateLocalModel,
  onDeleteLocalProvider,
}: {
  provider: ProviderCatalogEntry;
  busy?: boolean;
  /** Where the server models come from: an llm.toml file or the built-in default. */
  serverConfig?: ServerConfigSource;
  builtinDefault?: boolean;
  providerSources?: readonly ProviderSourceSummary[];
  onOpenPermissions?: () => void;
  onAddModel: () => void;
  onPatchLocalProfile: (
    patch:
      | Partial<ProviderModelProfile>
      | ((profile: ProviderModelProfile) => Partial<ProviderModelProfile>),
  ) => void;
  onDeleteLocalModel: (modelRef: string) => void;
  onDuplicateLocalModel: (model: ProviderModelEntry) => void;
  onDeleteLocalProvider: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const writable = useSettingsWritable();
  const sharedServer = getSharedServerInfo() !== null;
  const [tab, setTab] = useState("connection");
  const [modelsOpened, setModelsOpened] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modelSourceFilter, setModelSourceFilter] = useState<
    "all" | "local" | "server"
  >("all");
  useEffect(() => {
    setModelQuery("");
    setModelSourceFilter("all");
  }, [provider.id]);
  const isServerProvider = provider.serverModels.length > 0;
  const serverLabel = builtinDefault
    ? t("settings.builtinDefault")
    : t("settings.fromLlmToml", "From llm.toml");
  const localProfile = provider.localProfile;
  const activeSourceId = localProfile?.source ?? provider.source;
  const activeAccount = localProfile?.account ?? provider.account;
  const matchingSource = activeSourceId
    ? providerSources.find((src) => src.id === activeSourceId)
    : undefined;
  const committedBaseUrl = localProfile?.baseUrl ?? provider.baseUrl;
  const baseUrl = useSettingDraft(committedBaseUrl, provider.id);
  const localModels = localProfile?.models ?? [];
  const modelCount = provider.serverModels.length + localModels.length;
  const hasBothModelSources =
    provider.serverModels.length > 0 && localModels.length > 0;
  const activeModelSource = hasBothModelSources ? modelSourceFilter : "all";
  const normalizedModelQuery = modelQuery.trim().toLowerCase();
  const matchesModel = (...fields: (string | undefined)[]) =>
    fields.some((value) => value?.toLowerCase().includes(normalizedModelQuery));
  const filteredServerModels =
    activeModelSource === "local"
      ? []
      : normalizedModelQuery
        ? provider.serverModels.filter((model) =>
            matchesModel(model.model, model.name, model.id, model.protocol),
          )
        : provider.serverModels;
  const filteredLocalModels =
    activeModelSource === "server"
      ? []
      : normalizedModelQuery
        ? localModels.filter((model) =>
            matchesModel(model.modelId, model.name, model.ref, model.protocol),
          )
        : localModels;
  const filteredModelCount =
    filteredServerModels.length + filteredLocalModels.length;

  const commitBaseUrl = () => {
    if (localProfile && !activeSourceId && !baseUrl.conflict) {
      const next = baseUrl.draft.trim();
      baseUrl.setDraft(next);
      if (next !== committedBaseUrl) onPatchLocalProfile({ baseUrl: next });
    }
  };
  return (
    <div className="@container">
      <header className="flex min-w-0 items-center justify-between gap-3 pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="min-w-0 wrap-break-word text-xl font-semibold tracking-tight">
            {provider.id}
          </h3>
          {isServerProvider && <Badge variant="secondary">{serverLabel}</Badge>}
          {localProfile && (
            <Badge variant="secondary">
              {t("settings.localProvider", "Local")}
            </Badge>
          )}
          {activeSourceId && (
            <Badge variant="outline">
              {matchingSource
                ? resolveDisplayText(matchingSource.label, locale)
                : activeSourceId}
            </Badge>
          )}
          {matchingSource && (
            <Badge variant={matchingSource.ready ? "secondary" : "destructive"}>
              {providerSourceStatusLabel(matchingSource, t)}
            </Badge>
          )}
        </div>
        {localProfile && !isServerProvider && (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy || !writable}
            onClick={async () => {
              if (
                await requestConfirm({
                  title: t("settings.deleteProviderTitle"),
                  message: t("settings.deleteProviderConfirm"),
                  subject: provider.id,
                  confirmLabel: t("common.delete"),
                  cancelLabel: t("common.cancel"),
                  destructive: true,
                })
              )
                onDeleteLocalProvider();
            }}
            aria-label={t("common.delete", "Delete")}
            title={t("settings.deleteProviderTitle")}
          >
            <Trash2 />
          </Button>
        )}
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          if (value === "models") setModelsOpened(true);
        }}
        activationMode="manual"
      >
        <div className="ui-workspace-rule">
          <TabsList
            aria-label={provider.id}
            className="h-auto max-w-full justify-start gap-4 bg-transparent p-0"
          >
            <TabsTrigger
              value="connection"
              className="ui-tab-item px-3 whitespace-normal data-[state=active]:shadow-none"
            >
              {t("settings.providerConnectionTab")}
            </TabsTrigger>
            <TabsTrigger
              value="models"
              className="ui-tab-item gap-1.5 px-3 whitespace-normal data-[state=active]:shadow-none"
            >
              {t("settings.providerModelsTab")}
              <span
                aria-hidden="true"
                className="text-muted-foreground tabular-nums"
              >
                {modelCount}
              </span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          forceMount
          value="connection"
          hidden={tab !== "connection"}
          className="m-0 flex flex-col gap-5 pt-5 data-[state=inactive]:hidden"
        >
          {isServerProvider && localProfile && (
            <p className="text-xs text-muted-foreground">
              {t(
                builtinDefault
                  ? "settings.providerConnectionScopeBuiltin"
                  : "settings.providerConnectionScope",
              )}
            </p>
          )}
          <div className="grid min-w-0 items-start gap-3 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <label className="flex min-w-0 flex-col gap-1.5 text-[13px] font-medium">
              <span>{t("settings.baseUrl", "API endpoint")}</span>
              <input
                value={baseUrl.draft}
                placeholder={
                  isServerProvider && !localProfile
                    ? t("settings.providerEndpointPrivate")
                    : undefined
                }
                aria-invalid={baseUrl.conflict}
                readOnly={!localProfile || Boolean(activeSourceId)}
                disabled={!writable}
                onChange={(event) => baseUrl.setDraft(event.target.value)}
                onBlur={commitBaseUrl}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                className="h-9 w-full min-w-0 rounded-md border border-border bg-background px-2.5 font-mono text-sm outline-none read-only:text-muted-foreground focus:ring-1 focus:ring-primary"
              />
            </label>
            <ProtocolSelect
              provider={provider.provider}
              value={localProfile?.protocol ?? provider.protocol}
              disabled={!localProfile || !writable}
              onChange={(protocol) => onPatchLocalProfile({ protocol })}
            />
          </div>
          {baseUrl.conflict && (
            <SettingsDraftConflict onReload={baseUrl.reset} />
          )}
          {activeSourceId ? (
            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground">
                  {matchingSource?.reason === "capability_denied"
                    ? t("settings.providerSourcePermissionHint", {
                        plugin: matchingSource.pluginId,
                        defaultValue:
                          "Plugin {{plugin}} does not yet have instance-scope and provider-source permissions. Approve its requested capabilities in Permissions & Security first.",
                      })
                    : t("settings.providerSourceManagedCredentials", {
                        source: activeSourceId,
                      })}
                </p>
                {matchingSource?.reason === "capability_denied" &&
                onOpenPermissions ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={onOpenPermissions}
                  >
                    {t(
                      "settings.providerSourceOpenPermissions",
                      "Open Permissions & Security",
                    )}
                  </Button>
                ) : (
                  matchingSource &&
                  matchingSource.authFlows.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || !writable}
                      onClick={() =>
                        openPluginConfigFlow(
                          matchingSource.pluginId,
                          matchingSource.authFlows[0]!,
                        )
                      }
                    >
                      {t("settings.providerSourceSignIn")}
                    </Button>
                  )
                )}
              </div>
              {localProfile &&
                matchingSource &&
                (matchingSource.accountsMode === "many" ||
                  matchingSource.accounts.length > 0) && (
                  <ProviderSourceAccountSelect
                    accounts={matchingSource.accounts}
                    value={activeAccount ?? ""}
                    disabled={busy || !writable}
                    onChange={(account) => onPatchLocalProfile({ account })}
                    labelTextClassName="font-medium"
                    selectClassName="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                  />
                )}
            </div>
          ) : (
            <>
              <LlmKeysPane
                providerId={provider.id}
                showIntro={false}
                showPresetTests={false}
              />
              <LocalModelEndpointNote
                baseUrl={baseUrl.draft}
                provider={provider.provider}
              />
            </>
          )}
          {isServerProvider && (
            <ServerProviderNotice
              builtinDefault={builtinDefault}
              path={serverConfig?.path}
            />
          )}
          {sharedServer && (
            <SettingsHelp label={t("sharedServer.learnMore")}>
              <p>{t("sharedServer.keyAdvice")}</p>
              <a
                href={docsPageUrl(SHARED_SERVER_DOCS_PAGE, i18n.language)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-primary underline underline-offset-2"
              >
                {t("sharedServer.keyPolicyLink")}
              </a>
            </SettingsHelp>
          )}
        </TabsContent>

        <TabsContent
          forceMount
          value="models"
          hidden={tab !== "models"}
          className="m-0 flex flex-col gap-3 pt-5 data-[state=inactive]:hidden"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            {(modelCount > 5 || modelQuery || hasBothModelSources) && (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {(modelCount > 5 || modelQuery) && (
                  <SettingsListSearch
                    label={t("settings.searchModelsPlaceholder")}
                    value={modelQuery}
                    onChange={setModelQuery}
                  />
                )}
                {hasBothModelSources && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        {
                          id: "all",
                          label: t("settings.modelSourceAll", {
                            count: modelCount,
                            defaultValue: "All ({{count}})",
                          }),
                        },
                        {
                          id: "local",
                          label: `${t("settings.localProvider", "Local")} (${localModels.length})`,
                        },
                        {
                          id: "server",
                          label: `${serverLabel} (${provider.serverModels.length})`,
                        },
                      ] as const
                    ).map((pill) => (
                      <SettingsListFilter
                        key={pill.id}
                        active={activeModelSource === pill.id}
                        onClick={() => setModelSourceFilter(pill.id)}
                        label={pill.label}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto shrink-0"
              disabled={busy || !writable}
              onClick={onAddModel}
            >
              <Plus data-icon="inline-start" />
              {t("settings.addModel", "Add model")}
            </Button>
          </div>

          {modelsOpened &&
            (modelCount === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                {t("settings.noModels", "No models yet")}
              </p>
            ) : filteredModelCount === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-8 text-center">
                <p className="text-xs text-muted-foreground">
                  {t(
                    "settings.noMatchingModels",
                    "No models match the current filter.",
                  )}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setModelQuery("");
                    setModelSourceFilter("all");
                  }}
                >
                  {t("settings.github.resetFilters")}
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {filteredServerModels.map((model) => (
                  <ProviderModelRow
                    key={`server:${model.id}`}
                    provider={provider.provider}
                    protocol={model.protocol ?? provider.protocol}
                    modelId={model.model}
                    name={model.name}
                    presetId={model.id}
                    baseUrl={model.baseUrl}
                    capability={model.capability}
                    source="server"
                    sourceLabel={serverLabel}
                  />
                ))}
                {localProfile &&
                  filteredLocalModels.map((model) => (
                    <ProviderModelRow
                      key={model.ref}
                      provider={provider.provider}
                      protocol={
                        model.protocol ??
                        localProfile.protocol ??
                        provider.protocol
                      }
                      modelProtocol={model.protocol}
                      providerProtocol={
                        localProfile.protocol ?? provider.protocol
                      }
                      busy={busy}
                      onProtocolChange={(protocol) =>
                        onPatchLocalProfile((current) => ({
                          models: current.models.map((entry) =>
                            entry.ref === model.ref
                              ? { ...entry, protocol }
                              : entry,
                          ),
                        }))
                      }
                      modelId={model.modelId}
                      name={model.name}
                      presetId={model.ref}
                      baseUrl={localProfile.baseUrl}
                      source="local"
                      sourceLabel={t("settings.localModel", "Local model")}
                      reasoningEffort={model.reasoningEffort}
                      onNameChange={(name) =>
                        onPatchLocalProfile((current) => ({
                          models: current.models.map((entry) =>
                            entry.ref === model.ref
                              ? { ...entry, name }
                              : entry,
                          ),
                        }))
                      }
                      onDuplicate={() => onDuplicateLocalModel(model)}
                      onReasoningChange={(reasoningEffort) =>
                        onPatchLocalProfile((current) => ({
                          models: current.models.map((entry) =>
                            entry.ref === model.ref
                              ? { ...entry, reasoningEffort }
                              : entry,
                          ),
                        }))
                      }
                      onDelete={() => onDeleteLocalModel(model.ref)}
                    />
                  ))}
              </div>
            ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Explains why a provider defined outside Settings has no delete action. */
function ServerProviderNotice({
  builtinDefault,
  path = "llm.toml",
}: {
  builtinDefault: boolean;
  path?: string;
}) {
  const { t } = useTranslation();
  const openLlmTomlFile = useOpenLlmToml();
  return (
    <SettingsHelp label={t("settings.providerSourceHelp")}>
      <p className="wrap-break-word">
        {builtinDefault
          ? t("settings.providerBuiltinNotice", { path })
          : t("settings.providerFileNotice", { path })}
      </p>
      {isDesktopApp() && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => void openLlmTomlFile()}
        >
          <FileCode data-icon="inline-start" />
          {builtinDefault
            ? t("settings.createLlmToml")
            : t("settings.openLlmToml", "Open llm.toml")}
        </Button>
      )}
    </SettingsHelp>
  );
}

function ProviderModelRow({
  provider,
  protocol,
  modelProtocol,
  providerProtocol,
  baseUrl,
  onProtocolChange,
  modelId,
  name,
  presetId,
  source,
  sourceLabel,
  capability,
  onDelete,
  reasoningEffort,
  onReasoningChange,
  onNameChange,
  onDuplicate,
  busy = false,
}: {
  provider: string;
  protocol: string;
  baseUrl?: string;
  modelProtocol?: string;
  providerProtocol?: string;
  onProtocolChange?: (value: string | undefined) => void;
  modelId: string;
  name?: string;
  presetId: string;
  source: "server" | "local";
  sourceLabel: string;
  capability?: ModelCapabilityInfo;
  onDelete?: () => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningChange?: (value: ReasoningEffort | undefined) => void;
  onNameChange?: (value: string) => void;
  onDuplicate?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const writable = useSettingsWritable();
  const nameDraft = useSettingDraft(name ?? "", presetId);
  return (
    <div
      role="group"
      aria-label={name || modelId}
      className="flex min-w-0 flex-col gap-3 px-3 py-3.5 @lg:px-4"
    >
      <div className="grid min-w-0 gap-2 @lg:grid-cols-[minmax(0,1fr)_auto] @lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div
              className="min-w-0 wrap-break-word font-medium"
              title={modelId}
            >
              {name || modelId}
            </div>
            <Badge variant="secondary" className="shrink-0">
              {sourceLabel}
            </Badge>
          </div>
          {name && name !== modelId && (
            <div
              className="truncate font-mono text-xs text-muted-foreground"
              title={modelId}
            >
              {modelId}
            </div>
          )}
          <p className="mt-1 wrap-anywhere font-mono text-xs text-muted-foreground">
            {protocol}
            {baseUrl ? ` · ${baseUrl}` : ""}
          </p>
          <ModelCapabilitySummary
            provider={provider}
            modelId={modelId}
            protocol={protocol}
            baseCapability={capability}
          />
        </div>
        <PingButton
          layout="row"
          target={
            source === "local"
              ? { kind: "model", modelRef: presetId }
              : { kind: "preset", presetId }
          }
        >
          {onDuplicate && (
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={busy || !writable}
              onClick={onDuplicate}
              aria-label={t("settings.duplicateModelConfiguration")}
              title={t("settings.duplicateModelConfiguration")}
            >
              <Copy />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={busy || !writable}
              onClick={async () => {
                if (
                  await requestConfirm({
                    title: t("settings.deleteModelTitle"),
                    message: t("settings.deleteModelConfirm"),
                    subject: name || modelId,
                    confirmLabel: t("common.delete"),
                    cancelLabel: t("common.cancel"),
                    destructive: true,
                  })
                )
                  onDelete();
              }}
              aria-label={t("common.delete", "Delete")}
            >
              <Trash2 />
            </Button>
          )}
        </PingButton>
      </div>
      {onReasoningChange && (
        <details className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm py-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            />
            {t("settings.providerModelOptions")}
          </summary>
          <div className="mt-2 grid gap-4 border-t border-border pt-3 @lg:grid-cols-2">
            {onNameChange && (
              <label className="flex min-w-0 flex-col gap-1.5 text-[13px] font-medium">
                <span>{t("settings.modelConfigurationName")}</span>
                <input
                  disabled={!writable}
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
                  className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm font-normal outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
            )}
            {nameDraft.conflict && (
              <SettingsDraftConflict onReload={nameDraft.reset} />
            )}
            {onProtocolChange && (
              <ProtocolSelect
                provider={provider}
                inheritedProtocol={providerProtocol}
                disabled={!writable}
                value={modelProtocol ?? ""}
                onChange={(value) => onProtocolChange(value || undefined)}
                inheritLabel={t("settings.inheritProviderProtocol")}
              />
            )}
            <fieldset disabled={!writable} className="col-span-full min-w-0">
              <ModelReasoningSettings
                model={modelId}
                provider={provider}
                protocol={protocol}
                value={reasoningEffort}
                onChange={onReasoningChange}
              />
            </fieldset>
          </div>
        </details>
      )}
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
  const { t, i18n } = useTranslation();
  const result = useModelCapability(modelId, provider, protocol);
  const capability = resolveDisplayCapability(result, baseCapability);

  if (result === undefined && !capability) {
    return null;
  }
  const supportsImage = capability?.input.includes("image");
  return (
    <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
      <span>
        {result?.found && result.matchedModelId !== modelId
          ? result.matchedModelId
          : result?.found ||
              capability?.contextWindow ||
              capability?.maxOutputTokens
            ? null
            : t("settings.modelLimitsUnknown", {
                defaultValue: "Model limits unknown",
              })}
      </span>
      {capability?.output.includes("evaluation") && (
        <span>{t("settings.modalOutEvaluation")}</span>
      )}
      {supportsImage && (
        <span>{t("settings.modalInImage", "Image Input")}</span>
      )}
      {capability?.contextWindow && (
        <span>
          {capability.contextWindow.toLocaleString(i18n.language)}{" "}
          {t("settings.contextWindowShort")}
        </span>
      )}
    </div>
  );
}
