import { useTranslation } from "react-i18next";
import { Filter } from "lucide-react";
import { CATEGORY_STYLES, type EventCategory } from "./-debug-helpers.js";
import type { DebugView } from "./-debug-page-model.js";

export function DebugToolbar({
  debugView,
  filterCategory,
  onDebugViewChange,
  onFilterCategoryChange,
}: {
  debugView: DebugView;
  filterCategory: EventCategory | null;
  onDebugViewChange: (view: DebugView) => void;
  onFilterCategoryChange: (category: EventCategory | null) => void;
}) {
  const { t } = useTranslation();
  const views = [
    { id: "traces", label: t("debugger.traces") },
    { id: "data", label: t("debugger.sessionData") },
    { id: "cost", label: t("debugger.cost.tab", "Cost") },
    { id: "plugins", label: t("debugger.plugins.tab", "Plugins") },
  ] as const;

  return (
    <div className="ui-workspace-rule ui-workspace-content ui-rail flex shrink-0 flex-col gap-2 lg:flex-row lg:items-center">
      <div className="flex shrink-0 flex-wrap gap-x-1">
        {views.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onDebugViewChange(id)}
            aria-pressed={debugView === id}
            className="ui-tab-item wrap-anywhere px-3 py-1.5 text-sm font-medium transition-colors"
          >
            {label}
          </button>
        ))}
      </div>
      {debugView === "traces" && (
        <div className="relative flex min-w-0 items-center gap-2 py-1">
          <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain pr-8">
            <button
              onClick={() => onFilterCategoryChange(null)}
              aria-pressed={filterCategory === null}
              className={`min-h-8 shrink-0 rounded-(--radius-control) border px-2.5 text-xs transition-colors ${
                filterCategory === null
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("debugger.all")}
            </button>
            {(Object.keys(CATEGORY_STYLES) as EventCategory[]).map(
              (category) => {
                const style = CATEGORY_STYLES[category];
                return (
                  <button
                    key={category}
                    onClick={() =>
                      onFilterCategoryChange(
                        filterCategory === category ? null : category,
                      )
                    }
                    aria-pressed={filterCategory === category}
                    className={`flex min-h-8 shrink-0 items-center gap-1 rounded-(--radius-control) border px-2.5 text-xs transition-colors ${
                      filterCategory === category
                        ? `${style.border} ${style.bg} ${style.color}`
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <style.icon className="h-3 w-3" />
                    {t(`debugger.category.${category}`, category)}
                  </button>
                );
              },
            )}
          </div>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-(--surface-rail) to-transparent" />
        </div>
      )}
    </div>
  );
}
