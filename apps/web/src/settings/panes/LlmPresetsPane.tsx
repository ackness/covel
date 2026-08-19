import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Plus, Search, Server, Upload } from "lucide-react";
import {
  getProviderProfiles,
  profilesFromLegacyPresets,
  setProviderProfiles,
  upsertProviderModel,
  type ProviderModelProfile,
} from "@/services/api.js";
import { Button } from "@/components/ui/button.js";
import { useSession } from "@/stores/session-store.js";
import {
  buildProviderCatalog,
  EMPTY_PROVIDER_DRAFT,
  isLegacyPreset,
  normalizeProviderId,
  normalizeProviderProfiles,
  parseModelIds,
  sanitizeImportedProfiles,
  type ProviderCatalogEntry,
  type ProviderDraft,
} from "./llm-provider-catalog.js";
import { ProviderDetails } from "./llm-provider-details.js";
import { ModelDialog, ProviderDialog } from "./llm-provider-dialogs.js";

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
  const [query, setQuery] = useState("");
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [providerDraft, setProviderDraft] =
    useState<ProviderDraft>(EMPTY_PROVIDER_DRAFT);
  const [modelIdsDraft, setModelIdsDraft] = useState("");

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
  ) => {
    const providerId = normalizeProviderId(provider.id);
    if (!providerId) return;
    const modelIds = parseModelIds(rawIds);
    if (modelIds.length === 0) return;
    let nextProfiles = profiles;
    for (const modelId of modelIds) {
      nextProfiles = upsertProviderModel(nextProfiles, {
        providerId,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        modelId,
      }).profiles;
    }
    commit(nextProfiles);
  };

  const handleAddProvider = () => {
    const providerId = normalizeProviderId(providerDraft.providerId);
    if (!providerId || parseModelIds(providerDraft.modelIds).length === 0) {
      return;
    }
    addModels(
      {
        id: providerId,
        baseUrl: providerDraft.baseUrl,
        protocol: providerDraft.protocol,
      },
      providerDraft.modelIds,
    );
    setSelectedProviderId(providerId);
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

      <div className="grid min-h-[28rem] grid-cols-[10.5rem_minmax(0,1fr)] border border-border">
        <aside className="flex min-w-0 flex-col border-r border-border bg-muted/10">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("settings.searchProviders", "Search")}
                className="w-full border border-border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
          <div className="flex-1 space-y-0.5 overflow-y-auto p-1.5">
            {filteredCatalog.map((provider) => {
              const modelCount =
                provider.serverModels.length +
                (provider.localProfile?.models.length ?? 0);
              const active = provider.id === selectedProvider?.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => setSelectedProviderId(provider.id)}
                  className={`flex w-full items-center gap-2 px-2 py-2 text-left transition-colors ${
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10px] uppercase">
                    {provider.id.slice(0, 2)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {provider.id}
                    </span>
                    <span className="block text-[9px] text-muted-foreground">
                      {t("settings.modelCountShort", {
                        count: modelCount,
                        defaultValue: "{{count}} models",
                      })}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="border-t border-border p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs"
              onClick={() => setProviderDialogOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("settings.addProvider", "Add provider")}
            </Button>
          </div>
        </aside>

        <main className="min-w-0 p-3">
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
