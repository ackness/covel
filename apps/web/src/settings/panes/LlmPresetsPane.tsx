import { PaneNotice, usePaneNotice } from "../pane-notice.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, FileInput, FileOutput, Plus, Server } from "lucide-react";
import {
  fetchProviderSources,
  getSlotConfig,
  getProviderProfiles,
  setProviderProfiles,
  upsertProviderModel,
  type ProviderModelProfile,
  type ProviderModelEntry,
  type ProviderSourceSummary,
  type ReasoningEffort,
} from "@/services/api.js";
import { usePlatformUiState } from "@/lib/platform-ui-events.js";
import {
  DEFAULT_PROVIDER_PROTOCOL,
  getBuiltinProviderConnection,
  protocolOutputModalities,
} from "@covel/shared";
import { sameSettingValue } from "@covel/settings";
import { SettingsRevisionConflictError } from "@covel/settings";
import {
  useSettingsWritable,
  useSettingsSaveQueue,
} from "../use-settings-save.js";
import { emitToast } from "@/lib/toast-channel.js";
import { Button } from "@/components/ui/button.js";
import { useSession } from "@/stores/session-store.js";
import {
  buildProviderCatalog,
  bindFirstProviderModel,
  EMPTY_PROVIDER_DRAFT,
  normalizeProviderId,
  normalizeProviderProfiles,
  parseModelIds,
  parseProviderImport,
  type ProviderCatalogEntry,
  type ProviderDraft,
} from "./llm-provider-catalog.js";
import { ProviderList } from "./llm-provider-list.js";
import { ProviderDetails } from "./llm-provider-details.js";
import { ModelDialog, ProviderDialog } from "./llm-provider-dialogs.js";
import { useSettingsRevision } from "../use-settings-revision.js";
import { SettingsPaneHeader } from "../pane-layout.js";

/** Provider catalogue with connection settings and one-to-many model editing. */
export function LlmPresetsPane() {
  const { notice, show, clear } = usePaneNotice();
  const { t } = useTranslation();
  const { state } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { enqueue, saving, mounted, pending } = useSettingsSaveQueue();
  const importGeneration = useRef(0);
  useEffect(() => {
    return () => {
      importGeneration.current += 1;
    };
  }, []);
  const [profiles, setProfilesLocal] = useState<ProviderModelProfile[]>(() =>
    normalizeProviderProfiles(getProviderProfiles()),
  );
  const [providerSources, setProviderSources] = useState<
    ProviderSourceSummary[]
  >([]);
  const { instanceDataVersion } = usePlatformUiState();
  useEffect(() => {
    let cancelled = false;
    void fetchProviderSources()
      .then((res) => {
        if (!cancelled) setProviderSources(res.sources ?? []);
      })
      .catch(() => {
        if (!cancelled) setProviderSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceDataVersion]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [providerDraft, setProviderDraft] =
    useState<ProviderDraft>(EMPTY_PROVIDER_DRAFT);
  const [modelProtocolDraft, setModelProtocolDraft] = useState("");
  const [modelIdsDraft, setModelIdsDraft] = useState("");
  const [modelReasoningDraft, setModelReasoningDraft] = useState<
    Record<string, ReasoningEffort | undefined>
  >({});
  const revision = useSettingsRevision(["llm.providers"]);
  useEffect(() => {
    setProfilesLocal(normalizeProviderProfiles(getProviderProfiles()));
  }, [revision]);

  const catalog = useMemo(
    () => buildProviderCatalog(state.presets, profiles),
    [state.presets, profiles],
  );
  const filteredCatalog = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return catalog;
    return catalog.filter(
      (provider) =>
        provider.id.toLowerCase().includes(normalized) ||
        provider.serverModels.some(
          (model) =>
            model.model.toLowerCase().includes(normalized) ||
            model.name.toLowerCase().includes(normalized),
        ) ||
        provider.localProfile?.models.some(
          (model) =>
            model.modelId.toLowerCase().includes(normalized) ||
            model.name?.toLowerCase().includes(normalized),
        ),
    );
  }, [catalog, query]);
  const selectedProvider =
    catalog.find((provider) => provider.id === selectedProviderId) ??
    catalog[0];

  useEffect(() => {
    if (!selectedProviderId && catalog[0]) {
      setSelectedProviderId(catalog[0].id);
    }
  }, [catalog, selectedProviderId]);

  const writable = useSettingsWritable();

  const commit = async (
    next:
      | ProviderModelProfile[]
      | ((current: ProviderModelProfile[]) => ProviderModelProfile[]),
    slots?: ReturnType<typeof getSlotConfig>,
  ): Promise<boolean> => {
    if (!writable || !mounted.current) return false;
    const result = enqueue(async () => {
      try {
        const normalized = normalizeProviderProfiles(
          typeof next === "function" ? next(getProviderProfiles()) : next,
        );
        const result = await setProviderProfiles(normalized, slots);
        if (mounted.current) {
          setProfilesLocal(normalizeProviderProfiles(getProviderProfiles()));
        }
        if (result.unclearedProviderIds.length > 0) {
          const message = t("settings.providerKeyCleanupFailed");
          if (mounted.current) setSaveError(message);
          emitToast("error", message, result.unclearedProviderIds.join(", "));
        }
        return mounted.current;
      } catch (error) {
        const message = t("settings.saveFailed");
        if (mounted.current) {
          setProfilesLocal(normalizeProviderProfiles(getProviderProfiles()));
          setSaveError(message);
        }
        if (!(error instanceof SettingsRevisionConflictError))
          emitToast("error", message);
        return false;
      }
    });
    setSaveError(null);
    return result;
  };

  const prepareModels = (
    provider: Pick<
      ProviderCatalogEntry,
      "id" | "baseUrl" | "protocol" | "source" | "account"
    >,
    rawIds: string,
    reasoningDefaults: Record<string, ReasoningEffort | undefined> = {},
    modelProtocol?: string,
  ):
    { profiles: ProviderModelProfile[]; firstModelRef: string } | undefined => {
    const providerId = normalizeProviderId(provider.id);
    if (!providerId) return undefined;
    const modelIds = parseModelIds(rawIds);
    if (modelIds.length === 0) return undefined;
    let nextProfiles = profiles;
    let firstModelRef: string | undefined;
    for (const modelId of modelIds) {
      const result = upsertProviderModel(nextProfiles, {
        providerId,
        ...(provider.source ? { source: provider.source } : {}),
        ...(provider.account ? { account: provider.account } : {}),
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        modelProtocol,
        modelId,
        reasoningEffort: reasoningDefaults[modelId],
      });
      nextProfiles = result.profiles;
      firstModelRef ??= result.modelRef;
    }
    return firstModelRef
      ? { profiles: nextProfiles, firstModelRef }
      : undefined;
  };

  const handleAddProvider = async () => {
    const providerId = normalizeProviderId(providerDraft.providerId);
    if (!providerId || parseModelIds(providerDraft.modelIds).length === 0) {
      return;
    }
    const knownConnection = getBuiltinProviderConnection(providerId);
    const baseUrl =
      providerDraft.baseUrl.trim() || knownConnection?.baseUrl || "";
    const protocol =
      providerDraft.protocol ||
      knownConnection?.protocol ||
      DEFAULT_PROVIDER_PROTOCOL;
    const prepared = prepareModels(
      {
        id: providerId,
        ...(providerDraft.source ? { source: providerDraft.source } : {}),
        ...(providerDraft.account ? { account: providerDraft.account } : {}),
        baseUrl,
        protocol,
      },
      providerDraft.modelIds,
      providerDraft.reasoningDefaults,
    );
    if (!prepared) return;
    const currentSlots = getSlotConfig();
    const nextSlots = bindFirstProviderModel(
      currentSlots,
      profiles,
      protocolOutputModalities(protocol).includes("text")
        ? prepared.firstModelRef
        : undefined,
      state.presets,
      state.llmConfig?.slots ?? {},
    );
    if (!(await commit(prepared.profiles, nextSlots))) return;
    const boundSlots = Object.keys(nextSlots).filter(
      (slotId) => !currentSlots[slotId],
    );
    if (boundSlots.length > 0) {
      show({
        tone: "success",
        message: t("settings.providerRolesAssigned", {
          roles: boundSlots
            .map((slotId) => t(`session.modelUse.${slotId}`))
            .join(", "),
        }),
      });
    }
    setSelectedProviderId(providerId);
    setMobileDetailsOpen(true);
    setProviderDraft(EMPTY_PROVIDER_DRAFT);
    setProviderDialogOpen(false);
  };

  const handleAddModels = async () => {
    if (!selectedProvider) return;
    const prepared = prepareModels(
      selectedProvider,
      modelIdsDraft,
      modelReasoningDraft,
      modelProtocolDraft || undefined,
    );
    if (!prepared || !(await commit(prepared.profiles))) return;
    setModelReasoningDraft({});
    setModelProtocolDraft("");
    setModelIdsDraft("");
    setModelDialogOpen(false);
  };

  const patchLocalProfile = (
    patch:
      | Partial<ProviderModelProfile>
      | ((profile: ProviderModelProfile) => Partial<ProviderModelProfile>),
  ) => {
    if (!selectedProvider?.localProfile) return;
    const selectedId = normalizeProviderId(selectedProvider.id);
    void commit((current) =>
      current.map((profile) =>
        normalizeProviderId(profile.id) === selectedId
          ? {
              ...profile,
              ...(typeof patch === "function" ? patch(profile) : patch),
              id: selectedId,
            }
          : profile,
      ),
    );
  };

  const duplicateModel = (model: ProviderModelEntry) => {
    if (!selectedProvider?.localProfile) return;
    const names = new Set(
      selectedProvider.localProfile.models.map(
        (entry) => entry.name || entry.modelId,
      ),
    );
    const stem = t("settings.modelConfigurationCopy", {
      name: model.name || model.modelId,
    });
    let name = stem;
    let suffix = 2;
    while (names.has(name)) name = `${stem} ${suffix++}`;
    const result = upsertProviderModel(profiles, {
      providerId: selectedProvider.id,
      ...(selectedProvider.source ? { source: selectedProvider.source } : {}),
      ...(selectedProvider.account
        ? { account: selectedProvider.account }
        : {}),
      baseUrl: selectedProvider.baseUrl,
      protocol: selectedProvider.protocol,
      modelId: model.modelId,
      modelName: name,
      modelProtocol: model.protocol,
      reasoningEffort: model.reasoningEffort,
    });
    void commit(result.profiles);
  };

  const handleExport = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 2, providers: profiles }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "covel-model-providers.json";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    const generation = ++importGeneration.current;
    const base = new Map(
      structuredClone(getProviderProfiles()).map((profile) => [
        profile.id,
        profile,
      ]),
    );
    const ownsRead = () =>
      mounted.current && importGeneration.current === generation;
    setImportError(null);
    clear();
    let imported: ProviderModelProfile[];
    try {
      const text = await file.text();
      if (!ownsRead()) return;
      imported = parseProviderImport(JSON.parse(text));
    } catch {
      if (ownsRead()) setImportError(t("settings.importInvalid"));
      return;
    }
    const current = new Map(
      normalizeProviderProfiles(getProviderProfiles()).map((profile) => [
        profile.id,
        profile,
      ]),
    );
    if (
      pending.current > 0 ||
      imported.some(
        (profile) =>
          !sameSettingValue(current.get(profile.id), base.get(profile.id)) &&
          !sameSettingValue(current.get(profile.id), profile),
      )
    ) {
      setImportError(t("settings.providerImportChanged"));
      return;
    }
    for (const profile of imported) current.set(profile.id, profile);
    if (await commit(normalizeProviderProfiles([...current.values()]))) {
      if (ownsRead())
        show({
          tone: "success",
          message: t("settings.providerImportSucceeded"),
        });
    }
  };

  return (
    <div aria-busy={saving} className="@container min-w-0">
      <SettingsPaneHeader
        title={t("settings.providerConnections")}
        actions={
          <Button
            size="sm"
            disabled={saving || !writable}
            onClick={() => setProviderDialogOpen(true)}
            className="shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("settings.addProvider", "Add provider")}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-[11rem_minmax(0,1fr)] @2xl:gap-6">
        <ProviderList
          providers={filteredCatalog}
          selectedProviderId={selectedProvider?.id}
          query={query}
          mobileDetailsOpen={mobileDetailsOpen}
          onQueryChange={setQuery}
          onSelect={(id) => {
            setSelectedProviderId(id);
            setMobileDetailsOpen(true);
          }}
        />

        <section
          aria-label={t("settings.providerConnections")}
          className={`${mobileDetailsOpen ? "block" : "hidden @2xl:block"} min-w-0 @2xl:border-l @2xl:border-border @2xl:pl-6`}
        >
          <Button
            variant="ghost"
            size="sm"
            className="mb-3 @2xl:hidden"
            onClick={() => setMobileDetailsOpen(false)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("settings.backToProviders", { defaultValue: "All providers" })}
          </Button>
          {selectedProvider ? (
            <ProviderDetails
              key={selectedProvider.id}
              provider={selectedProvider}
              serverConfig={state.llmConfig?.source}
              builtinDefault={
                state.llmConfig?.source
                  ? undefined
                  : Object.values(state.llmConfig?.slots ?? {}).some(
                      (slot) =>
                        slot.provider === selectedProvider.id &&
                        slot.builtinDefault,
                    )
              }
              providerSources={providerSources}
              busy={saving || !writable}
              onAddModel={() => setModelDialogOpen(true)}
              onPatchLocalProfile={patchLocalProfile}
              onDuplicateLocalModel={duplicateModel}
              onDeleteLocalModel={(modelRef) => {
                patchLocalProfile((profile) => ({
                  models: profile.models.filter(
                    (model) => model.ref !== modelRef,
                  ),
                }));
              }}
              onDeleteLocalProvider={() => {
                setMobileDetailsOpen(false);
                void commit((current) =>
                  current.filter(
                    (profile) =>
                      normalizeProviderId(profile.id) !==
                      normalizeProviderId(selectedProvider.id),
                  ),
                );
              }}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
              <Server className="h-6 w-6" />
              <p className="text-xs">
                {t("settings.noProvidersTitle", "No providers registered yet")}
              </p>
            </div>
          )}
        </section>
      </div>

      <div className="mt-5 flex flex-col gap-3 border-t border-border pt-3">
        <PaneNotice
          notice={
            importError || saveError
              ? { tone: "error", message: importError || saveError || "" }
              : notice
          }
        />
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" onClick={handleExport}>
            <FileOutput data-icon="inline-start" />
            {t("settings.export")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving || !writable}
            onClick={() => fileRef.current?.click()}
          >
            <FileInput data-icon="inline-start" />
            {t("settings.import")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            disabled={saving || !writable}
            accept=".json"
            aria-label={t("settings.import")}
            className="hidden"
            onChange={handleImport}
          />
        </div>
      </div>

      <ProviderDialog
        open={providerDialogOpen}
        busy={saving || !writable}
        error={saveError}
        draft={providerDraft}
        providerSources={providerSources}
        onOpenChange={(open) => {
          if (pending.current === 0) setProviderDialogOpen(open);
        }}
        onDraftChange={setProviderDraft}
        onSubmit={handleAddProvider}
      />
      {selectedProvider && (
        <ModelDialog
          open={modelDialogOpen}
          busy={saving || !writable}
          error={saveError}
          providerId={selectedProvider.id}
          provider={selectedProvider.provider}
          source={selectedProvider.source}
          account={selectedProvider.account}
          baseUrl={selectedProvider.baseUrl}
          protocol={selectedProvider.protocol}
          modelProtocol={modelProtocolDraft}
          onProtocolChange={setModelProtocolDraft}
          reasoningDefaults={modelReasoningDraft}
          onReasoningChange={setModelReasoningDraft}
          value={modelIdsDraft}
          onOpenChange={(open) => {
            if (pending.current === 0) setModelDialogOpen(open);
          }}
          onChange={setModelIdsDraft}
          onSubmit={handleAddModels}
        />
      )}
    </div>
  );
}
