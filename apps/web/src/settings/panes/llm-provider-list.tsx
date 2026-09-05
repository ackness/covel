import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { ProviderCatalogEntry } from "./llm-provider-catalog.js";

export function ProviderList({
  providers,
  selectedProviderId,
  query,
  mobileDetailsOpen,
  onQueryChange,
  onSelect,
  onAddProvider,
}: {
  providers: ProviderCatalogEntry[];
  selectedProviderId?: string;
  query: string;
  mobileDetailsOpen: boolean;
  onQueryChange: (value: string) => void;
  onSelect: (id: string) => void;
  onAddProvider: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside
      className={`${mobileDetailsOpen ? "hidden lg:flex" : "flex"} min-w-0 flex-col lg:border-r border-border bg-muted/10`}
    >
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("settings.searchProviders", "Search")}
            className="w-full border border-border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto p-1.5">
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
          onClick={onAddProvider}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("settings.addProvider", "Add provider")}
        </Button>
      </div>
    </aside>
  );
}
