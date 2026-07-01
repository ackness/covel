import { useTranslation } from "react-i18next";
import {
  Activity,
  ChevronsUp,
  Database,
  Filter,
  Gamepad2,
  Layers,
  Radio,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useDebugPageData } from "./-debug-page-data.js";
import { DebugToolbar } from "./-debug-toolbar.js";
import { EventDetailPanel } from "./-event-detail-panel.js";
import { CostPanel } from "./-cost-panel.js";
import { SessionDataView } from "./-session-data-view.js";
import { SessionSidebar } from "./-session-sidebar.js";
import { TraceTimeline } from "./-trace-timeline.js";

export function DebugRoutePage({ sid }: { sid?: string }) {
  const { t } = useTranslation();
  const {
    sessions,
    selectedSessionId,
    visibleTurns,
    loading,
    autoRefresh,
    filterCategory,
    expandedTurns,
    expandedRuntimes,
    selectedEvent,
    debugView,
    snapshotData,
    traceDiscovery,
    totalEvents,
    storyTurnCount,
    isPartial,
    loadingOlder,
    selectSession,
    openSelectedSession,
    loadTraces,
    loadOlder,
    loadAll,
    setAutoRefresh,
    setFilterCategory,
    setSelectedEvent,
    setDebugView,
    toggleTurn,
    toggleRuntime,
  } = useDebugPageData(sid);

  return (
    <div className="flex h-full w-full flex-col border-t border-[var(--rule-color)] overflow-hidden">
      <div
        className="flex-shrink-0 min-h-11 px-4 py-2 border-b border-[var(--rule-color)] flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
        style={{ background: "var(--surface-page)" }}
      >
        <div className="flex items-center gap-3">
          <h1 className="flex items-baseline gap-3">
            <span className="ui-meta text-[10px] text-muted-foreground">
              § TRACE
            </span>
            <span className="ui-title text-sm font-semibold tracking-tight">
              {t("debugger.title")}
            </span>
            <Terminal className="w-3.5 h-3.5 opacity-50" />
          </h1>
          {selectedSessionId && (
            <Badge
              variant="outline"
              className="font-mono text-[10px]"
              title={
                isPartial
                  ? t(
                      "debugger.windowedHint",
                      "Only the most recent trace window is loaded — counts are partial.",
                    )
                  : undefined
              }
            >
              {t("debugger.turn", { count: storyTurnCount })} · {totalEvents}{" "}
              {t("session.events")}
              {isPartial && (
                <span className="ml-1 opacity-70">
                  · {t("debugger.windowed", "window")}
                </span>
              )}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="hidden md:flex items-center gap-1.5 border-r border-[var(--rule-color)] pr-3 text-[10px] text-muted-foreground">
            <span className="ui-meta text-[9px]">{t("debugger.sessions")}</span>
            <span className="font-mono text-foreground">{sessions.length}</span>
            <span className="ui-meta text-[9px]">
              {t("debugger.view", "View")}
            </span>
            <span className="font-mono text-foreground uppercase">
              {debugView}
            </span>
          </div>
          {selectedSessionId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-muted-foreground gap-1"
              onClick={openSelectedSession}
            >
              <Gamepad2 className="w-3 h-3" />
              {t("debugger.toSession")}
            </Button>
          )}
          {selectedSessionId && isPartial && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground gap-1"
                onClick={loadOlder}
                disabled={loadingOlder}
              >
                <ChevronsUp
                  className={`w-3 h-3 ${loadingOlder ? "animate-pulse" : ""}`}
                />
                {t("debugger.loadOlder", "Load older")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground gap-1"
                onClick={loadAll}
                disabled={loading}
              >
                <Layers className="w-3 h-3" />
                {t("debugger.loadAll", "Load all")}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 px-2 text-[11px] gap-1 ${autoRefresh ? "text-emerald-500" : "text-muted-foreground"}`}
            onClick={() => setAutoRefresh((value) => !value)}
          >
            <Radio
              className={`w-3 h-3 ${autoRefresh ? "animate-pulse" : ""}`}
            />
            {autoRefresh ? t("debugger.live") : t("debugger.auto")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground"
            onClick={loadTraces}
            disabled={loading}
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {selectedSessionId && (
        <div className="flex-shrink-0 border-b border-[var(--rule-color)] bg-[color-mix(in_oklab,var(--surface-page)_82%,var(--surface-inset))] px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[10px] text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="ui-meta text-[9px]">
                {t("debugger.session", "Session")}
              </span>
              <span className="truncate font-mono text-foreground">
                {selectedSessionId}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Activity className="h-3 w-3 text-primary" />
              <span>{t("debugger.turn", { count: storyTurnCount })}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Database className="h-3 w-3 text-muted-foreground" />
              <span>
                {totalEvents} {t("session.events")}
              </span>
            </span>
            {isPartial && (
              <span
                className="inline-flex items-center gap-1.5 text-amber-500/80"
                title={t(
                  "debugger.windowedHint",
                  "Only the most recent trace window is loaded — counts are partial.",
                )}
              >
                <Layers className="h-3 w-3" />
                <span>{t("debugger.windowedBadge", "Partial window")}</span>
              </span>
            )}
            {filterCategory && (
              <span className="inline-flex items-center gap-1.5">
                <Filter className="h-3 w-3 text-muted-foreground" />
                <span>{t(`debugger.category.${filterCategory}`)}</span>
              </span>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelectSession={selectSession}
        />

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <DebugToolbar
            debugView={debugView}
            filterCategory={filterCategory}
            onDebugViewChange={setDebugView}
            onFilterCategoryChange={setFilterCategory}
          />

          <div className="flex flex-1 min-h-0 overflow-hidden">
            {debugView === "data" ? (
              <SessionDataView
                selectedSessionId={selectedSessionId}
                snapshotData={snapshotData}
                traceDiscovery={traceDiscovery}
              />
            ) : debugView === "cost" ? (
              <CostPanel
                turns={visibleTurns}
                isPartial={isPartial}
                onLoadAll={loadAll}
              />
            ) : (
              <>
                <TraceTimeline
                  selectedSessionId={selectedSessionId}
                  turns={visibleTurns}
                  loading={loading}
                  expandedTurns={expandedTurns}
                  expandedRuntimes={expandedRuntimes}
                  filterCategory={filterCategory}
                  selectedEventSeq={selectedEvent?.seq}
                  onToggleTurn={toggleTurn}
                  onToggleRuntime={toggleRuntime}
                  onSelectEvent={setSelectedEvent}
                />
                {selectedEvent && (
                  <EventDetailPanel
                    event={selectedEvent}
                    onClose={() => setSelectedEvent(null)}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
