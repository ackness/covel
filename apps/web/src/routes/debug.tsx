import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Database,
  FileJson,
  Filter,
  Gamepad2,
  Layers,
  MessageSquare,
  Radio,
  RefreshCw,
  Shield,
  Terminal,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  CATEGORY_STYLES,
  fmtTime,
  type EventCategory,
} from "./debug/-debug-helpers.js";
import { useDebugPageData } from "./debug/-debug-page-data.js";
import { EventDetail } from "./debug/-event-detail.js";
import {
  DataSection,
  FrameworkDiscoveryPanel,
  JsonBlock,
  PluginContractsPanel,
  PluginDataIndexPanel,
} from "./debug/-session-data-panels.js";
import { TurnCard } from "./debug/-trace-panels.js";

interface DebugSearchParams {
  sid?: string;
}

export const Route = createFileRoute("/debug")({
  component: DebugPage,
  validateSearch: (search: Record<string, unknown>): DebugSearchParams => ({
    sid: typeof search.sid === "string" ? search.sid : undefined,
  }),
});

function DebugPage() {
  const { t } = useTranslation();
  const { sid } = Route.useSearch();
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
    selectSession,
    openSelectedSession,
    loadTraces,
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
            <Badge variant="outline" className="font-mono text-[10px]">
              {t("debugger.turn", { count: storyTurnCount })} · {totalEvents}{" "}
              {t("session.events")}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="hidden md:flex items-center gap-1.5 border-r border-[var(--rule-color)] pr-3 text-[10px] text-muted-foreground">
            <span className="ui-meta text-[9px]">SESSIONS</span>
            <span className="font-mono text-foreground">{sessions.length}</span>
            <span className="ui-meta text-[9px]">VIEW</span>
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
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 px-2 text-[11px] gap-1 ${autoRefresh ? "text-emerald-500" : "text-muted-foreground"}`}
            onClick={() => setAutoRefresh((v) => !v)}
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
              <span className="ui-meta text-[9px]">SESSION</span>
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
          <Toolbar
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

function SessionSidebar({
  sessions,
  selectedSessionId,
  onSelectSession,
}: {
  sessions: Array<{
    id: string;
    status: string;
    turnCount: number;
    createdAt: string;
  }>;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="w-56 flex-shrink-0 border-r border-[var(--rule-color)] flex flex-col min-h-0 ui-rail">
      <div className="px-3 py-2 border-b border-[var(--rule-color)]">
        <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t("debugger.sessions")}
        </h2>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-1.5 space-y-0.5">
          {sessions.length === 0 && (
            <p className="text-[11px] text-muted-foreground italic px-2 py-3">
              {t("debugger.noSessions")}
            </p>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => onSelectSession(s.id)}
              className={`w-full text-left px-2.5 py-2 text-[11px] border transition-colors ${
                selectedSessionId === s.id
                  ? "border-primary/40 bg-primary/5 text-foreground"
                  : "border-transparent hover:border-border hover:bg-muted/20 text-muted-foreground"
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${
                    s.status === "active" ? "bg-emerald-500" : "bg-zinc-400"
                  }`}
                />
                <span className="font-mono truncate text-[10px]">{s.id}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <Badge variant="secondary" className="text-[9px] h-4 px-1">
                  {s.status} · t{s.turnCount}
                </Badge>
                <span title={s.createdAt}>
                  {fmtTime(s.createdAt, {
                    withMillis: false,
                    alwaysDate: true,
                  })}
                </span>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function Toolbar({
  debugView,
  filterCategory,
  onDebugViewChange,
  onFilterCategoryChange,
}: {
  debugView: "traces" | "data";
  filterCategory: EventCategory | null;
  onDebugViewChange: (view: "traces" | "data") => void;
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
          {(Object.keys(CATEGORY_STYLES) as EventCategory[]).map((cat) => {
            const style = CATEGORY_STYLES[cat];
            return (
              <button
                key={cat}
                onClick={() =>
                  onFilterCategoryChange(filterCategory === cat ? null : cat)
                }
                className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors shrink-0 flex items-center gap-1 ${
                  filterCategory === cat
                    ? `${style.border} ${style.bg} ${style.color}`
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <style.icon className="w-2.5 h-2.5" />
                {t(`debugger.category.${cat}`, cat)}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

function SessionDataView({
  selectedSessionId,
  snapshotData,
  traceDiscovery,
}: {
  selectedSessionId: string | null;
  snapshotData: ReturnType<typeof useDebugPageData>["snapshotData"];
  traceDiscovery: ReturnType<typeof useDebugPageData>["traceDiscovery"];
}) {
  const { t } = useTranslation();

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="p-4 max-w-5xl space-y-4">
        {!selectedSessionId && (
          <p className="text-sm text-muted-foreground py-20 text-center">
            {t("debugger.selectSession")}
          </p>
        )}
        {selectedSessionId && !snapshotData && (
          <p className="text-sm text-muted-foreground py-20 text-center">
            {t("debugger.loadingSessionData")}
          </p>
        )}
        {snapshotData && (
          <>
            <DataSection
              title={t("debugger.dataSection.session")}
              icon={<Layers className="w-3.5 h-3.5" />}
            >
              <JsonBlock
                data={{
                  id: snapshotData.session.id,
                  worldId: snapshotData.session.worldId,
                  phase: snapshotData.session.phase,
                  turnCount: snapshotData.session.turnCount,
                  locale: snapshotData.session.locale,
                }}
              />
            </DataSection>

            <DataSection
              title={t("debugger.dataSection.frameworkCapabilities")}
              icon={<Shield className="w-3.5 h-3.5" />}
            >
              {traceDiscovery ? (
                <FrameworkDiscoveryPanel framework={traceDiscovery.framework} />
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noFrameworkCapabilities")}
                </p>
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.pluginContracts")} (${traceDiscovery?.plugins.length ?? 0})`}
              icon={<FileJson className="w-3.5 h-3.5" />}
            >
              {traceDiscovery && traceDiscovery.plugins.length > 0 ? (
                <PluginContractsPanel plugins={traceDiscovery.plugins} />
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noPluginContracts")}
                </p>
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.pluginDataIndex")} (${traceDiscovery?.pluginData.length ?? 0})`}
              icon={<Database className="w-3.5 h-3.5" />}
            >
              {traceDiscovery &&
              traceDiscovery.pluginData.some(
                (entry) => entry.namespaces.length > 0,
              ) ? (
                <PluginDataIndexPanel pluginData={traceDiscovery.pluginData} />
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noPluginDataIndex")}
                </p>
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.characters")} (${snapshotData.characters.length})`}
              icon={<Gamepad2 className="w-3.5 h-3.5" />}
            >
              {snapshotData.characters.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noCharactersCreated")}
                </p>
              ) : (
                snapshotData.characters.map((ch) => (
                  <div
                    key={ch.id}
                    className="border border-border p-2 space-y-1"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold">{ch.name}</span>
                      <Badge variant="outline" className="text-[9px]">
                        {ch.type}
                      </Badge>
                    </div>
                    {ch.description && (
                      <p className="text-[11px] text-muted-foreground">
                        {ch.description}
                      </p>
                    )}
                    {ch.fields && <JsonBlock data={ch.fields} />}
                  </div>
                ))
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.messages")} (${snapshotData.messages.length})`}
              icon={<MessageSquare className="w-3.5 h-3.5" />}
            >
              {snapshotData.messages.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noMessages")}
                </p>
              ) : (
                snapshotData.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`border p-2 text-[11px] ${
                      m.role === "user"
                        ? "border-blue-500/20 bg-blue-500/5"
                        : "border-border"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-[9px]">
                        {m.role}
                      </Badge>
                      {m.kind && (
                        <Badge variant="outline" className="text-[9px]">
                          {m.kind}
                        </Badge>
                      )}
                      {m.runtimeId && (
                        <span className="text-[9px] text-muted-foreground font-mono">
                          {m.runtimeId}
                        </span>
                      )}
                    </div>
                    {m.content ? (
                      <p className="text-muted-foreground whitespace-pre-wrap line-clamp-3">
                        {m.content}
                      </p>
                    ) : m.block ? (
                      <Badge variant="outline" className="text-[9px]">
                        {t("debugger.blockType")}:{" "}
                        {(m.block as Record<string, unknown>).type as string}
                      </Badge>
                    ) : null}
                  </div>
                ))
              )}
            </DataSection>

            <DataSection
              title={t("debugger.dataSection.gameState")}
              icon={<Database className="w-3.5 h-3.5" />}
            >
              {Object.keys(snapshotData.gameState).length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noStateData")}
                </p>
              ) : (
                <JsonBlock data={snapshotData.gameState} />
              )}
            </DataSection>

            <DataSection
              title={`${t("debugger.dataSection.executionSteps")} (${snapshotData.executionSteps.length})`}
              icon={<Activity className="w-3.5 h-3.5" />}
            >
              {snapshotData.executionSteps.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("debugger.noExecutionTraces")}
                </p>
              ) : (
                snapshotData.executionSteps.map((step, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-[11px] font-mono py-0.5"
                  >
                    <Badge variant="outline" className="text-[9px] shrink-0">
                      {step.type}
                    </Badge>
                    <span className="text-muted-foreground truncate">
                      {((step.payload as Record<string, unknown>)
                        ?.runtimeId as string) ?? step.turnId}
                    </span>
                    {(step.payload as Record<string, unknown>)?.durationMs !=
                      null && (
                      <span className="text-[9px] text-muted-foreground shrink-0">
                        {
                          (step.payload as Record<string, unknown>)
                            .durationMs as number
                        }
                        ms
                      </span>
                    )}
                  </div>
                ))
              )}
            </DataSection>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function TraceTimeline({
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
  turns: ReturnType<typeof useDebugPageData>["visibleTurns"];
  loading: boolean;
  expandedTurns: Set<string>;
  expandedRuntimes: Set<string>;
  filterCategory: EventCategory | null;
  selectedEventSeq?: number;
  onToggleTurn: (turnId: string) => void;
  onToggleRuntime: (key: string) => void;
  onSelectEvent: (
    event: Parameters<typeof TurnCard>[0]["turn"]["events"][number],
  ) => void;
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

function EventDetailPanel({
  event,
  onClose,
}: {
  event: Parameters<typeof EventDetail>[0]["event"];
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="w-80 flex-shrink-0 border-l border-border flex flex-col min-h-0 ui-rail">
      <div className="px-3 py-2 border-b border-[var(--rule-color)] flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t("debugger.eventDetail")}
        </h3>
        <button
          onClick={onClose}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          {t("debugger.close")}
        </button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <EventDetail event={event} />
      </ScrollArea>
    </div>
  );
}
