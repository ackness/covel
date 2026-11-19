import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import type { ProviderCatalogEntry } from "./llm-provider-catalog.js";

export function ProviderList({
  providers,
  selectedProviderId,
  query,
  mobileDetailsOpen,
  onQueryChange,
  onSelect,
}: {
  providers: ProviderCatalogEntry[];
  selectedProviderId?: string;
  query: string;
  mobileDetailsOpen: boolean;
  onQueryChange: (value: string) => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <aside
      className={`${mobileDetailsOpen ? "hidden @2xl:flex" : "flex"} min-w-0 flex-col gap-3`}
    >
      <div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label={t("settings.searchProviders")}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("settings.searchProvidersPlaceholder")}
            className="h-9 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>
      <div className="ui-scroll flex max-h-96 flex-col gap-0.5 overflow-y-auto">
        {providers.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            {query.trim()
              ? t("settings.providerSearchEmpty")
              : t("settings.noProvidersTitle")}
          </p>
        )}
        {providers.map((provider) => {
          const modelCount =
            provider.serverModels.length +
            (provider.localProfile?.models.length ?? 0);
          const active = provider.id === selectedProviderId;
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => onSelect(provider.id)}
              aria-pressed={active}
              className="ui-rail-item flex items-center gap-2 px-2 py-2 text-left transition-colors"
            >
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs uppercase"
              >
                {provider.id.slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {provider.id}
                </span>
                <span className="block text-[11px] text-muted-foreground">
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
    </aside>
  );
}
