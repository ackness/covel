import { useTranslation } from "react-i18next";
import { Activity, Terminal } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import type * as api from "@/services/api.js";
import type { EventCategory } from "./-debug-helpers.js";
import type { VisibleTurn } from "./-debug-page-model.js";
import { TurnCard } from "./-trace-panels.js";

export function TraceTimeline({
  selectedSessionId,
  turns,
  loading,
  expandedTurns,
  expandedRuntimes,
  filterCategory,
  selectedEventSeq,
  onToggleTurn,
  onToggleRuntime,
  onSelectEvent,
}: {
  selectedSessionId: string | null;
  turns: VisibleTurn[];
  loading: boolean;
  expandedTurns: Set<string>;
  expandedRuntimes: Set<string>;
  filterCategory: EventCategory | null;
  selectedEventSeq?: number;
  onToggleTurn: (turnId: string) => void;
  onToggleRuntime: (key: string) => void;
  onSelectEvent: (event: api.TraceEvent) => void;
}) {
  const { t } = useTranslation();

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="p-4 space-y-2 max-w-5xl">
        {!selectedSessionId && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Terminal className="w-8 h-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">
              {t("debugger.selectSessionToInspect")}
            </p>
          </div>
        )}

        {selectedSessionId && turns.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Activity className="w-8 h-8 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">
              {t("debugger.noTraceEvents")}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {t("debugger.eventsWillAppear")}
            </p>
          </div>
        )}

        {turns.map(({ turn, turnIndex }) => (
          <TurnCard
            key={turn.turnId}
            turn={turn}
            turnIndex={turnIndex}
            expanded={expandedTurns.has(turn.turnId)}
            onToggle={() => onToggleTurn(turn.turnId)}
            expandedRuntimes={expandedRuntimes}
            onToggleRuntime={onToggleRuntime}
            filterCategory={filterCategory}
            onSelectEvent={onSelectEvent}
            selectedEventSeq={selectedEventSeq}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
