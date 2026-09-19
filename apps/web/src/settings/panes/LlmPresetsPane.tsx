import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download, Plus, Server, Upload } from "lucide-react";
import {
  getSlotConfig,
  getProviderProfiles,
  setProviderProfiles,
  upsertProviderModel,
  type ProviderModelProfile,
  type ProviderModelEntry,
  type ReasoningEffort,
} from "@/services/api.js";
import { getBuiltinProviderConnection } from "@covel/shared";
import { sameSettingValue } from "@covel/settings";
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

export { buildProviderCatalog } from "./llm-provider-catalog.js";

/** Provider catalogue with connection settings and one-to-many model editing. */
export function LlmPresetsPane() {
  const { t } = useTranslation();
  const { state } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef(false);
  const mounted = useRef(false);
  const importGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      importGeneration.current += 1;
    };
  }, []);
  const [profiles, setProfilesLocal] = useState<ProviderModelProfile[]>(() =>
    normalizeProviderProfiles(getProviderProfiles()),
  );
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [providerDraft, setProviderDraft] =
    useState<ProviderDraft>(EMPTY_PROVIDER_DRAFT);
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

  const commit = async (
    next: ProviderModelProfile[],
    slots = getSlotConfig(),
  ): Promise<boolean> => {
    if (pendingSave.current || !mounted.current) return false;
    pendingSave.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const normalized = normalizeProviderProfiles(next);
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
    } catch {
      const message = t("settings.saveFailed");
      if (mounted.current) {
        setProfilesLocal(normalizeProviderProfiles(getProviderProfiles()));
        setSaveError(message);
      }
      emitToast("error", message);
      return false;
    } finally {
      pendingSave.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const prepareModels = (
    provider: Pick<ProviderCatalogEntry, "id" | "baseUrl" | "protocol">,
    rawIds: string,
    reasoningDefaults: Record<string, ReasoningEffort | undefined> = {},
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
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
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
      providerDraft.baseUrl.trim() || !knownConnection
        ? providerDraft.protocol
        : knownConnection.protocol;
    const prepared = prepareModels(
      {
        id: providerId,
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
      prepared.firstModelRef,
      state.presets,
      Object.keys(state.llmConfig?.slots ?? {}),
    );
    if (!(await commit(prepared.profiles, nextSlots))) return;
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
    );
    if (!prepared || !(await commit(prepared.profiles))) return;
    setModelReasoningDraft({});
    setModelIdsDraft("");
    setModelDialogOpen(false);
  };

  const patchLocalProfile = (patch: Partial<ProviderModelProfile>) => {
    if (!selectedProvider?.localProfile) return;
    const selectedId = normalizeProviderId(selectedProvider.id);
    void commit(
      profiles.map((profile) =>
        normalizeProviderId(profile.id) === selectedId
          ? { ...profile, ...patch, id: selectedId }
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
      baseUrl: selectedProvider.baseUrl,
      protocol: selectedProvider.protocol,
      modelId: model.modelId,
      modelName: name,
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
      pendingSave.current ||
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
    await commit(normalizeProviderProfiles([...current.values()]));
  };

  return (
    <fieldset disabled={saving} className="min-w-0 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t("settings.providerConnections", "Provider connections")}
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.providerCatalogHint",
              "Choose a provider, configure its connection once, then maintain all of its model IDs in one list.",
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setProviderDialogOpen(true)}
          className="shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("settings.addProvider", "Add provider")}
        </Button>
      </div>

      <div className="grid min-h-112 grid-cols-1 lg:grid-cols-[10.5rem_minmax(0,1fr)] border border-border">
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
          onAddProvider={() => setProviderDialogOpen(true)}
        />

        <main
          className={`${mobileDetailsOpen ? "block" : "hidden lg:block"} min-w-0 p-3`}
        >
          <Button
            variant="ghost"
            size="sm"
            className="mb-3 lg:hidden"
            onClick={() => setMobileDetailsOpen(false)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("settings.backToProviders", { defaultValue: "All providers" })}
          </Button>
          {selectedProvider ? (
            <ProviderDetails
              provider={selectedProvider}
              onAddModel={() => setModelDialogOpen(true)}
              onPatchLocalProfile={patchLocalProfile}
              onDuplicateLocalModel={duplicateModel}
              onDeleteLocalModel={(modelRef) => {
                const profile = selectedProvider.localProfile;
                if (!profile) return;
                patchLocalProfile({
                  models: profile.models.filter(
                    (model) => model.ref !== modelRef,
                  ),
                });
              }}
              onDeleteLocalProvider={() => {
                setMobileDetailsOpen(false);
                void commit(
                  profiles.filter(
                    (profile) =>
                      normalizeProviderId(profile.id) !==
                      normalizeProviderId(selectedProvider.id),
                  ),
                );
              }}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Server className="h-6 w-6" />
              <p className="text-xs">
                {t("settings.noProvidersTitle", "No providers configured")}
              </p>
            </div>
          )}
        </main>
      </div>

      {(importError || saveError) && (
        <p role="alert" className="text-xs text-destructive">
          {importError || saveError}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          className="flex-1 text-xs"
        >
          <Download className="h-3.5 w-3.5" />
          {t("settings.export")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileRef.current?.click()}
          className="flex-1 text-xs"
        >
          <Upload className="h-3.5 w-3.5" />
          {t("settings.import")}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          aria-label={t("settings.import")}
          className="hidden"
          onChange={handleImport}
        />
      </div>

      <ProviderDialog
        open={providerDialogOpen}
        busy={saving}
        error={saveError}
        draft={providerDraft}
        onOpenChange={(open) => {
          if (!pendingSave.current) setProviderDialogOpen(open);
        }}
        onDraftChange={setProviderDraft}
        onSubmit={handleAddProvider}
      />
      {selectedProvider && (
        <ModelDialog
          open={modelDialogOpen}
          busy={saving}
          error={saveError}
          providerId={selectedProvider.id}
          protocol={selectedProvider.protocol}
          reasoningDefaults={modelReasoningDraft}
          onReasoningChange={setModelReasoningDraft}
          value={modelIdsDraft}
          onOpenChange={(open) => {
            if (!pendingSave.current) setModelDialogOpen(open);
          }}
          onChange={setModelIdsDraft}
          onSubmit={handleAddModels}
        />
      )}
    </fieldset>
  );
}
