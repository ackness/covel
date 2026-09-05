import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download, Plus, Server, Upload } from "lucide-react";
import {
  getSlotConfig,
  getProviderProfiles,
  profilesFromLegacyPresets,
  setProviderProfiles,
  setSlotConfig,
  upsertProviderModel,
  type ProviderModelProfile,
} from "@/services/api.js";
import { getBuiltinProviderConnection } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { useSession } from "@/stores/session-store.js";
import {
  buildProviderCatalog,
  bindFirstProviderModel,
  EMPTY_PROVIDER_DRAFT,
  isLegacyPreset,
  normalizeProviderId,
  normalizeProviderProfiles,
  parseModelIds,
  sanitizeImportedProfiles,
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
        provider.serverModels.some((model) =>
          model.model.toLowerCase().includes(normalized),
        ) ||
        provider.localProfile?.models.some((model) =>
          model.modelId.toLowerCase().includes(normalized),
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

  const commit = (next: ProviderModelProfile[]) => {
    const normalized = normalizeProviderProfiles(next);
    setProfilesLocal(normalized);
    setProviderProfiles(normalized);
  };

  const addModels = (
    provider: Pick<ProviderCatalogEntry, "id" | "baseUrl" | "protocol">,
    rawIds: string,
  ): string | undefined => {
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
      });
      nextProfiles = result.profiles;
      firstModelRef ??= result.modelRef;
    }
    commit(nextProfiles);
    return firstModelRef;
  };

  const handleAddProvider = () => {
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
    const firstModelRef = addModels(
      {
        id: providerId,
        baseUrl,
        protocol,
      },
      providerDraft.modelIds,
    );
    const currentSlots = getSlotConfig();
    const nextSlots = bindFirstProviderModel(
      currentSlots,
      profiles,
      firstModelRef,
      state.presets,
      Object.keys(state.llmConfig?.slots ?? {}),
    );
    if (nextSlots !== currentSlots) setSlotConfig(nextSlots);
    setSelectedProviderId(providerId);
    setMobileDetailsOpen(true);
    setProviderDraft(EMPTY_PROVIDER_DRAFT);
    setProviderDialogOpen(false);
  };

  const handleAddModels = () => {
    if (!selectedProvider) return;
    addModels(selectedProvider, modelIdsDraft);
    setModelIdsDraft("");
    setModelDialogOpen(false);
  };

  const patchLocalProfile = (patch: Partial<ProviderModelProfile>) => {
    if (!selectedProvider?.localProfile) return;
    const selectedId = normalizeProviderId(selectedProvider.id);
    commit(
      profiles.map((profile) =>
        normalizeProviderId(profile.id) === selectedId
          ? { ...profile, ...patch, id: selectedId }
          : profile,
      ),
    );
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

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw: unknown = JSON.parse(String(reader.result));
        const candidates =
          raw && typeof raw === "object" && "providers" in raw
            ? (raw as { providers?: unknown }).providers
            : raw;
        if (!Array.isArray(candidates) || candidates.length > 200) return;
        const imported = [
          ...sanitizeImportedProfiles(
            profilesFromLegacyPresets(candidates.filter(isLegacyPreset)),
          ),
          ...sanitizeImportedProfiles(candidates),
        ];
        const byId = new Map(
          normalizeProviderProfiles(profiles).map((profile) => [
            profile.id,
            profile,
          ]),
        );
        for (const profile of imported) byId.set(profile.id, profile);
        commit(normalizeProviderProfiles([...byId.values()]));
      } catch {
        // Ignore malformed imports and preserve the current configuration.
      }
    };
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="space-y-3">
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
                commit(
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
        draft={providerDraft}
        onOpenChange={setProviderDialogOpen}
        onDraftChange={setProviderDraft}
        onSubmit={handleAddProvider}
      />
      {selectedProvider && (
        <ModelDialog
          open={modelDialogOpen}
          providerId={selectedProvider.id}
          value={modelIdsDraft}
          onOpenChange={setModelDialogOpen}
          onChange={setModelIdsDraft}
          onSubmit={handleAddModels}
        />
      )}
    </div>
  );
}
