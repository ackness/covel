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

  return (
    <div className="ui-rail flex shrink-0 flex-col gap-2 border-b border-(--rule-color) p-2 sm:min-h-12 sm:flex-row sm:items-center sm:px-4">
      <div className="grid shrink-0 grid-cols-3 gap-1 sm:flex sm:border-r sm:border-(--rule-color) sm:pr-3">
        <button
          onClick={() => onDebugViewChange("traces")}
          aria-pressed={debugView === "traces"}
          className={`min-h-8 border px-3 text-xs uppercase tracking-wider transition-colors ${
            debugView === "traces"
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("debugger.traces")}
        </button>
        <button
          onClick={() => onDebugViewChange("data")}
          aria-pressed={debugView === "data"}
          className={`min-h-8 border px-3 text-xs uppercase tracking-wider transition-colors ${
            debugView === "data"
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("debugger.sessionData")}
        </button>
        <button
          onClick={() => onDebugViewChange("cost")}
          aria-pressed={debugView === "cost"}
          className={`min-h-8 border px-3 text-xs uppercase tracking-wider transition-colors ${
            debugView === "cost"
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("debugger.cost.tab", "Cost")}
        </button>
      </div>
      {debugView === "traces" && (
        <div className="relative flex min-w-0 items-center gap-2">
          <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain pr-8">
            <button
              onClick={() => onFilterCategoryChange(null)}
              aria-pressed={filterCategory === null}
              className={`min-h-8 shrink-0 border px-3 text-xs uppercase tracking-wider transition-colors ${
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
                    className={`flex min-h-8 shrink-0 items-center gap-1 border px-3 text-xs uppercase tracking-wider transition-colors ${
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
