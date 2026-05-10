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
    <div className="flex-shrink-0 h-9 px-4 border-b border-[var(--rule-color)] ui-rail flex items-center gap-4 overflow-x-auto">
      <div className="flex items-center gap-1 shrink-0 border-r border-[var(--rule-color)] pr-3">
        <button
          onClick={() => onDebugViewChange("traces")}
          className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors ${
            debugView === "traces"
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("debugger.traces")}
        </button>
        <button
          onClick={() => onDebugViewChange("data")}
          className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors ${
            debugView === "data"
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("debugger.sessionData")}
        </button>
      </div>
      {debugView === "traces" && (
        <>
          <Filter className="w-3 h-3 text-muted-foreground shrink-0" />
          <button
            onClick={() => onFilterCategoryChange(null)}
            className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors shrink-0 ${
              filterCategory === null
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("debugger.all")}
          </button>
          {(Object.keys(CATEGORY_STYLES) as EventCategory[]).map((category) => {
            const style = CATEGORY_STYLES[category];
            return (
              <button
                key={category}
                onClick={() =>
                  onFilterCategoryChange(
                    filterCategory === category ? null : category,
                  )
                }
                className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors shrink-0 flex items-center gap-1 ${
                  filterCategory === category
                    ? `${style.border} ${style.bg} ${style.color}`
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <style.icon className="w-2.5 h-2.5" />
                {t(`debugger.category.${category}`, category)}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}
