import { memo, useState, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Database,
  BookOpen,
  HelpCircle,
  Maximize2,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { Badge } from "@/components/ui/badge.js";
import { WorldDocumentPanel } from "./world-document-panel.js";
import { PluginPanel } from "./plugin-panel.js";
import {
  useRightPanelState,
  type RightPanelState,
  type StorageStatusData,
} from "./right-panel-state.js";
export type { StorageStatusData } from "./right-panel-state.js";
import { DatabasePanel } from "./database-panel.js";
import type { WorldRecord } from "@/services/api.js";
import type { ServerStoreBackend } from "@/services/data-service.js";
import {
  compactTabLabel,
  groupShortLabel,
  panelProviderLabel,
  planPluginPanelProviders,
  pluginPanelKey,
  selectedPluginPanelIndex,
} from "@/lib/plugin-panel-tabs.js";
import { useSession, useSessionActions } from "@/stores/session-store.js";
import { type RightPanelRequest } from "@/lib/nav-events.js";
import { resolveIcon } from "@/lib/catalog/helpers.js";
import { useThemeLayout } from "@/theme-system/use-theme-layout.js";
import { useOverflowEdges } from "@/hooks/use-overflow-edges.js";
import { PanelStatus } from "./panel-status.js";
import { PanelTabMenu } from "./panel-tab-menu.js";

export interface StorageStatus {
  readonly browserAuthority: boolean;
  readonly backend: ServerStoreBackend | null;
}

/** Resolve the durable authority before choosing the execution-store label. */
export function resolveStorageStatus(
  data: StorageStatusData | null | undefined,
): StorageStatus | null {
  const browserAuthority = data?.frontendMode === "local";
  if (!browserAuthority && !data?.backend) return null;
  return {
    browserAuthority,
    backend: data?.backend ?? null,
  };
}

interface RightPanelTabItem {
  id: string;
  value: string;
  label: string;
  shortLabel?: string;
  icon: LucideIcon;
  title?: string;
}

function resolvePluginIcon(name: string): LucideIcon {
  const resolved = resolveIcon(name);
  if (resolved) return resolved;
  // Surface the mismatch loudly in dev so plugin authors notice mis-typed
  // icons without crashing the panel.
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      `[right-panel] unknown lucide icon "${name}" — falling back to HelpCircle`,
    );
  }
  return HelpCircle;
}

interface RightPanelProps {
  panelState?: RightPanelState;
  panelRequest?: RightPanelRequest | null;
  sessionId: string;
  /** Currently loaded world — its `lore` (WORLD.md) is rendered in the World tab. */
  world: WorldRecord | null;
  /**
   * State change patches — only used as a freshness signal for the DB
   * tab. We pass the length as `refreshKey` so the panel re-fetches
   * whenever a new patch lands.
   */
  statePatches: Array<{ id: string }>;
}

/**
 * Right panel — split into two sections in the activity bar:
 *   1. Framework-owned tabs (世界 / 数据库) — always present while a session is loaded.
 *   2. Plugin-driven tabs (from /api/ui-specs) — rendered below a thin divider.
 *
 * The hardcoded 角色 and 世界观 tabs were removed because they duplicated
 * plugin contributions (char-creator "角色" and world-init
 * "世界维度"); the pretty world-dimensions rendering moved into the
 * plugin tab via the `WorldDimensions` covelRegistry component.
 *
 * Memoised: the session view re-renders on every slot projection and stream
 * tick, and a panel re-render remounts the plugin components inside it —
 * dropping whatever the player was doing there (an upload in flight, an open
 * field). The panel reads its own state through hooks, so it only needs to
 * follow its props.
 */
export const RightPanel = memo(function RightPanel(props: RightPanelProps) {
  return props.panelState ? (
    <SessionRightPanel
      key={props.sessionId}
      {...props}
      panelState={props.panelState}
    />
  ) : (
    <OwnedRightPanel key={props.sessionId} {...props} />
  );
});

function OwnedRightPanel(props: RightPanelProps) {
  const panelState = useRightPanelState(props.sessionId, props.panelRequest);
  return <SessionRightPanel {...props} panelState={panelState} />;
}

function SessionRightPanel({
  sessionId,
  world,
  statePatches,
  panelState,
}: RightPanelProps & { panelState: RightPanelState }) {
  const { t, i18n } = useTranslation();
  const tabRailRef = useRef<HTMLDivElement>(null);
  const {
    storageData,
    pluginTabGroups,
    activePluginSubTab,
    selectPluginSubTab,
    activeTab,
    setActiveTab,
    panelStateCache,
    specsStatus,
    specsError,
    retrySpecs,
  } = panelState;
  const { state: sessionState } = useSession();
  const { upsertInteractionDraft } = useSessionActions();
  // Key of the plugin panel shown in the large dialog, if any.
  const [expandedPanelKey, setExpandedPanelKey] = useState<string | null>(null);
  // A side panel may queue a line for the player to send — a map's "go to the
  // docks" — but never sends it: the player still confirms in the composer.
  // One stable object, because new handlers would re-render every panel.
  const panelHandlers = useMemo(
    () => ({
      draftMessage: (params: Record<string, unknown>) => {
        const text = String(params.text ?? "").trim();
        if (!text) return;
        const selectionGroup =
          typeof params.selectionGroup === "string"
            ? params.selectionGroup
            : undefined;
        upsertInteractionDraft({
          id: selectionGroup
            ? `panel:${selectionGroup}`
            : `panel-draft:${text}`,
          turnId: "panel",
          interactionId: selectionGroup ?? `panel-draft:${text}`,
          type: "suggestion",
          label: text,
          values: { text },
          selectionGroup,
        });
      },
    }),
    [upsertInteractionDraft],
  );
  // `bar` puts labelled tabs across the top; `rail` keeps the icon strip.
  const barTabs = useThemeLayout().panelTabs === "bar";
  const tabItems = useMemo<RightPanelTabItem[]>(
    () => [
      {
        id: "world",
        value: "world",
        label: t("session.worldTab"),
        icon: BookOpen,
      },
      {
        id: "database",
        value: "database",
        label: t("session.database"),
        icon: Database,
      },
      ...pluginTabGroups.map((group) => ({
        id: `plugin-${group.id}`,
        value: `plugin-${group.id}`,
        label: group.label,
        shortLabel: groupShortLabel(group),
        icon: resolvePluginIcon(group.icon),
      })),
    ],
    [pluginTabGroups, t],
  );

  const storageStatus = resolveStorageStatus(storageData);

  // The asynchronous storage footer can shrink the rail after a tab was
  // selected. Keep that selection visible without moving the content pane.
  // In the bar it is centred, clear of the faded edges of the strip.
  useLayoutEffect(() => {
    const rail = tabRailRef.current;
    if (!rail) return;
    const revealSelection = () =>
      rail
        .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.scrollIntoView?.({
          block: "nearest",
          inline: barTabs ? "center" : "nearest",
        });
    revealSelection();
    // Fonts, the active label's weight and the overflow menu can resize the
    // strip after selection without changing any React state above.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(revealSelection);
    observer?.observe(rail);
    if (rail.firstElementChild) observer?.observe(rail.firstElementChild);
    return () => observer?.disconnect();
  }, [activeTab, tabItems, storageData, barTabs]);
  const tabEdges = useOverflowEdges(
    tabRailRef,
    `${barTabs}:${tabItems.length}`,
  );
  const shownTab = tabItems.some((item) => item.value === activeTab)
    ? activeTab
    : "world";

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {specsStatus === "loading" && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {t("common.loading")}
        </p>
      )}
      {specsStatus === "error" && (
        <div role="alert" className="px-3 py-2 text-xs text-destructive">
          <p>{t("session.panelLoadFailed")}</p>
          <p className="wrap-break-word">{specsError}</p>
          <button type="button" className="underline" onClick={retrySpecs}>
            {t("common.retry")}
          </button>
        </div>
      )}
      <Tabs
        value={shownTab}
        onValueChange={setActiveTab}
        className={`flex-1 flex min-h-0 min-w-0 ${barTabs ? "flex-col" : ""}`}
        orientation={barTabs ? "horizontal" : "vertical"}
      >
        {barTabs ? (
          <div className="ui-panel-tabbar relative flex shrink-0 items-center gap-1 border-b border-(--rule-color) px-3">
            <div
              ref={tabRailRef}
              data-fade-start={tabEdges.start}
              data-fade-end={tabEdges.end}
              className="ui-scroll-fade min-w-0 flex-1 overflow-x-auto overscroll-contain"
              onWheel={(event) => {
                // A mouse wheel has one axis; over the strip it moves the strip.
                if (Math.abs(event.deltaY) > Math.abs(event.deltaX))
                  event.currentTarget.scrollLeft += event.deltaY;
              }}
            >
              <TabsList className="flex h-auto w-max items-center justify-start gap-1 rounded-none bg-transparent p-0 py-2 text-muted-foreground">
                {tabItems.map((item) => {
                  const ItemIcon = item.icon;
                  return (
                    <TabsTrigger
                      key={item.id}
                      value={item.value}
                      className="ui-panel-tab h-8 shrink-0 gap-1.5 rounded-(--radius-control) border-0 px-2.5 text-[13px] font-normal text-muted-foreground shadow-none touch-manipulation data-[state=active]:bg-accent data-[state=active]:font-medium data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
                      title={item.title ?? item.label}
                      // The tab may show a short label; its name stays the full one.
                      aria-label={item.label}
                    >
                      <ItemIcon
                        className="ui-panel-tab-icon h-3.5 w-3.5 shrink-0"
                        aria-hidden
                      />
                      <span>{item.shortLabel ?? item.label}</span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </div>
            {/* What the strip hides is one click away. */}
            {(tabEdges.start || tabEdges.end) && (
              <PanelTabMenu
                items={tabItems}
                active={shownTab}
                label={t("session.allPanels")}
                onSelect={setActiveTab}
              />
            )}
          </div>
        ) : (
          <div
            ref={tabRailRef}
            className="border-r border-(--rule-color) shrink-0 w-12 min-h-0 overflow-y-auto overscroll-contain"
            style={{
              background:
                "color-mix(in oklab, var(--surface-rail) 70%, var(--surface-page))",
            }}
          >
            <TabsList className="flex h-auto min-h-full w-full flex-col items-center justify-start rounded-none bg-transparent p-0 text-muted-foreground">
              {tabItems.map((item, idx) => {
                const ItemIcon = item.icon;
                const afterFrameworkTabs = idx === 2;
                return (
                  <div
                    key={item.id}
                    className="w-full flex flex-col items-center"
                  >
                    {afterFrameworkTabs && (
                      <div
                        aria-hidden
                        className="w-6 h-px bg-border my-1.5 shrink-0"
                      />
                    )}
                    <TabsTrigger
                      value={item.value}
                      className="group relative min-h-12 w-full rounded-none border-0 px-0 py-1 text-muted-foreground shadow-none touch-manipulation data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                      title={item.title ?? item.label}
                      aria-label={item.label}
                    >
                      <span
                        aria-hidden
                        className="absolute left-0 top-1 bottom-1 w-0.5 bg-transparent transition-colors group-data-[state=active]:bg-(--accent-primary)"
                      />
                      <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden px-1">
                        <ItemIcon className="w-4 h-4 shrink-0" />
                        <span className="block w-full max-w-full truncate text-center text-[9px] leading-none whitespace-nowrap">
                          {item.shortLabel ?? compactTabLabel(item.label)}
                        </span>
                      </span>
                    </TabsTrigger>
                  </div>
                );
              })}
            </TabsList>
          </div>
        )}
        {/* The labelled-tab layouts keep the player's status in view above
            whichever tab is open. */}
        {barTabs && <PanelStatus sessionId={sessionId} />}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
          <TabsContent value="world" className="p-4 m-0 max-w-full">
            {!barTabs && (
              <div className="mb-4 flex min-w-0 items-center gap-2 border-b border-(--rule-color) pb-3">
                <BookOpen className="w-4 h-4 shrink-0 text-muted-foreground" />
                <h3 className="ui-title text-sm font-semibold tracking-tight truncate">
                  {t("session.worldTab")}
                </h3>
              </div>
            )}
            <WorldDocumentPanel world={world} />
          </TabsContent>
          <TabsContent value="database" className="p-4 m-0 max-w-full">
            {!barTabs && (
              <div className="mb-4 flex min-w-0 items-center gap-2 border-b border-(--rule-color) pb-3">
                <Database className="w-4 h-4 shrink-0 text-muted-foreground" />
                <h3 className="ui-title text-sm font-semibold tracking-tight truncate">
                  {t("session.database")}
                </h3>
              </div>
            )}
            <DatabasePanel
              sessionId={sessionId}
              refreshKey={statePatches.length}
            />
          </TabsContent>

          {/* Dynamic plugin panel content (memory, codex, npc-graph, etc.) */}
          {pluginTabGroups.map((group) => {
            const subIdx = selectedPluginPanelIndex(
              group,
              activePluginSubTab[group.id],
            );
            const currentSub = group.subPanels[subIdx];
            const providerPlan = planPluginPanelProviders(group, subIdx);
            const GroupIcon = resolvePluginIcon(group.icon);

            return (
              <TabsContent
                key={`plugin-content-${group.id}`}
                value={`plugin-${group.id}`}
                className="p-4 m-0 max-w-full"
              >
                <div
                  className={`ui-panel-title mb-3 flex min-w-0 items-center gap-2 ${barTabs ? "" : "border-b border-(--rule-color) pb-3"}`}
                >
                  {!barTabs && (
                    <GroupIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                  )}
                  <h3
                    className={`ui-title font-semibold tracking-tight truncate ${barTabs ? "text-base" : "text-sm"}`}
                  >
                    {group.label}
                  </h3>
                </div>

                {/* Provider switcher — only when 2+ plugins share the group */}
                {providerPlan.multiProvider && (
                  <div className="flex items-center gap-2 mb-2 ui-meta text-[10px] text-muted-foreground">
                    <span>{t("session.provider", "provider")}</span>
                    <div className="flex items-center border border-(--rule-color) rounded-(--radius-control) overflow-hidden">
                      {providerPlan.providers.map((p) => {
                        const isActive =
                          p.pluginId === providerPlan.activeProviderId;
                        return (
                          <button
                            key={p.pluginId}
                            type="button"
                            onClick={() => {
                              // jump to first sub-panel of this provider
                              const firstIdx = p.subs[0]?.idx;
                              if (typeof firstIdx === "number") {
                                selectPluginSubTab(
                                  group.id,
                                  pluginPanelKey(group.subPanels[firstIdx]!),
                                );
                              }
                            }}
                            className={`px-2 py-0.5 text-[10px] font-medium tracking-wider transition-colors max-w-40 truncate ${
                              isActive
                                ? "bg-foreground text-(--surface-page)"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                            title={p.pluginId}
                          >
                            {panelProviderLabel(
                              p.pluginId,
                              group.id,
                              p.subs.map((item) => item.sub),
                              sessionState.sessionPlugins,
                              i18n.language,
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Sub-panel chips (filtered to active provider) */}
                {(providerPlan.activeProviderSubs.length > 1 ||
                  (!providerPlan.multiProvider &&
                    group.subPanels.length > 1)) && (
                  <div className="flex items-center gap-2 mb-3 border-b border-(--rule-color) pb-2 flex-wrap">
                    {(providerPlan.multiProvider
                      ? providerPlan.activeProviderSubs
                      : group.subPanels.map((sub, idx) => ({ sub, idx }))
                    ).map(({ sub, idx }) => {
                      const SubIcon = resolvePluginIcon(sub.icon);
                      const isActive = idx === subIdx;
                      return (
                        <button
                          key={pluginPanelKey(sub)}
                          type="button"
                          onClick={() =>
                            selectPluginSubTab(group.id, pluginPanelKey(sub))
                          }
                          className={`flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium border-b-2 -mb-px transition-colors ${
                            isActive
                              ? "border-(--accent-primary) text-foreground"
                              : "border-transparent text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <SubIcon className="w-3 h-3" />
                          <span className="truncate max-w-32">{sub.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {currentSub && (
                  <>
                    <div className="mb-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedPanelKey(pluginPanelKey(currentSub))
                        }
                        aria-label={t("session.expandPanel")}
                        title={t("session.expandPanel")}
                        className="ui-btn ui-btn-quiet h-7 w-7 p-0 text-muted-foreground"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {/* One instance at a time: while the panel is in the large
                        dialog, the column only says so. */}
                    {expandedPanelKey === pluginPanelKey(currentSub) ? (
                      <p className="py-6 text-center text-xs text-muted-foreground">
                        {t("session.panelExpanded")}
                      </p>
                    ) : (
                      <PluginPanel
                        key={pluginPanelKey(currentSub)}
                        panelId={currentSub.id}
                        pluginId={currentSub.pluginId}
                        spec={currentSub.spec}
                        stateCache={panelStateCache}
                        handlers={panelHandlers}
                        enableDevtools={import.meta.env.DEV}
                      />
                    )}
                    <Dialog
                      open={expandedPanelKey === pluginPanelKey(currentSub)}
                      onOpenChange={(open) => {
                        if (!open) setExpandedPanelKey(null);
                      }}
                    >
                      <DialogContent className="ui-panel-dialog flex max-h-[90vh] w-[min(72rem,94vw)] max-w-none flex-col sm:max-w-none">
                        <DialogHeader>
                          <DialogTitle>{currentSub.label}</DialogTitle>
                        </DialogHeader>
                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                          <PluginPanel
                            key={pluginPanelKey(currentSub)}
                            panelId={currentSub.id}
                            pluginId={currentSub.pluginId}
                            spec={currentSub.spec}
                            stateCache={panelStateCache}
                            handlers={panelHandlers}
                            expanded
                          />
                        </div>
                      </DialogContent>
                    </Dialog>
                  </>
                )}
              </TabsContent>
            );
          })}
        </div>
      </Tabs>
      {storageStatus &&
        // The backend name is operator detail. The labelled-tab layouts keep
        // the footer only for the one case a player must know: nothing is
        // being saved.
        (!barTabs ||
          (!storageStatus.browserAuthority &&
            storageStatus.backend === "memory")) && (
          <div className="border-t border-border px-3 py-2 flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0 bg-[color-mix(in_oklab,var(--surface-rail)_82%,var(--surface-page))]">
            <Database className="w-3 h-3" />
            <span className="ui-meta text-[9px]">
              {t("session.store", "Store")}
            </span>
            <Badge
              variant="outline"
              className={`text-[9px] rounded-none ${
                storageStatus.browserAuthority ||
                storageStatus.backend === "pg" ||
                storageStatus.backend === "sqlite"
                  ? "border-green-500/40 text-green-600 dark:text-green-400"
                  : "border-amber-500/40 text-amber-600 dark:text-amber-400"
              }`}
            >
              {storageStatus.browserAuthority
                ? t("session.storage.browserIndexedDbAuthority")
                : storageStatus.backend === "pg"
                  ? "PostgreSQL"
                  : storageStatus.backend === "sqlite"
                    ? "SQLite"
                    : "Memory"}
            </Badge>
            {storageStatus.browserAuthority && (
              <span className="text-muted-foreground">
                {t("session.storage.memoryExecutionMirror")}
              </span>
            )}
            {!storageStatus.browserAuthority &&
              storageStatus.backend === "memory" && (
                <span className="text-amber-600 dark:text-amber-400">
                  {t("session.memoryStoreWarning", "Data lost on restart")}
                </span>
              )}
          </div>
        )}
    </div>
  );
}
