import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Database, BookOpen, HelpCircle, type LucideIcon } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { Badge } from "@/components/ui/badge.js";
import { WorldDocumentPanel } from "./world-document-panel.js";
import { PluginPanel } from "./plugin-panel.js";
import type { PluginPanelStateCache } from "./plugin-panel.js";
import { DatabasePanel } from "./database-panel.js";
import {
  fetchServerHealth,
  fetchUiSpecs,
  listPluginData,
} from "@/services/api.js";
import type { WorldRecord } from "@/services/api.js";
import type { ServerStoreBackend } from "@/services/data-service.js";
import {
  aggregateSpecsIntoGroups,
  compactTabLabel,
  groupShortLabel,
  panelProviderLabel,
  planPluginPanelProviders,
  resolvePluginPanelTarget,
  type PluginPanelTabGroup,
} from "@/lib/plugin-panel-tabs.js";
import { loadPluginData } from "@/stores/plugin-data-store.js";
import { useSession } from "@/stores/session-store.js";
import { onNavEvent } from "@/lib/nav-events.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { resolveIcon } from "@/lib/catalog/helpers.js";

export interface StorageStatusData {
  readonly backend?: ServerStoreBackend;
  readonly frontendMode?: "local" | "remote";
}

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

export interface RightPanelProps {
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
 */
export function RightPanel({
  sessionId,
  world,
  statePatches,
}: RightPanelProps) {
  const { t, i18n } = useTranslation();
  const pluginPanelStateCacheRef = useRef<PluginPanelStateCache>(new Map());
  const [storageData, setStorageData] = useState<StorageStatusData | null>(
    null,
  );
  const [pluginTabGroups, setPluginTabGroups] = useState<PluginPanelTabGroup[]>(
    [],
  );
  const [activePluginSubTab, setActivePluginSubTab] = useState<
    Record<string, number>
  >({});
  const [activeTab, setActiveTab] = useState("world");
  const [pendingPluginPanelTarget, setPendingPluginPanelTarget] = useState<{
    readonly pluginId: string;
    readonly panelId: string;
  } | null>(null);
  const { state: sessionState } = useSession();
  const activePluginKey = useMemo(
    () =>
      sessionState.sessionPlugins
        .filter((plugin) => plugin.active)
        .map((plugin) => plugin.id)
        .sort()
        .join("\u001f"),
    [sessionState.sessionPlugins],
  );

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

  useEffect(() => {
    fetchServerHealth()
      .then((h) => setStorageData(h.storage?.data ?? null))
      .catch(ignoreError("fetch server health"));
  }, []);

  const storageStatus = resolveStorageStatus(storageData);

  // Topbar nav → controlled tab switch. Previously this dispatched synthetic
  // mouse events at the trigger DOM node matched by aria-label, which silently
  // broke whenever the label translation drifted.
  useEffect(() => {
    return onNavEvent((event) => {
      if (event === "open-database") {
        setActiveTab("database");
      } else if (event === "open-images") {
        // ponytail: match by declared icon — a first-class "media surface"
        // capability flag on panel specs would be sturdier if this grows.
        const target = pluginTabGroups.find((group) =>
          group.subPanels.some((sub) => sub.icon === "image"),
        );
        if (target) setActiveTab(`plugin-${target.id}`);
      } else if (
        typeof event === "object" &&
        event.type === "open-plugin-panel"
      ) {
        setPendingPluginPanelTarget({
          pluginId: event.pluginId,
          panelId: event.panelId,
        });
      }
    });
  }, [pluginTabGroups]);

  // Command results may arrive before /api/ui-specs. Keep the intent pending
  // and replay it once the command owner's exact sub-panel becomes available.
  useEffect(() => {
    if (!pendingPluginPanelTarget) return;
    const target = resolvePluginPanelTarget(
      pluginTabGroups,
      pendingPluginPanelTarget.pluginId,
      pendingPluginPanelTarget.panelId,
    );
    if (!target) return;
    setActivePluginSubTab((prev) => ({
      ...prev,
      [target.groupId]: target.subPanelIndex,
    }));
    setActiveTab(`plugin-${target.groupId}`);
    setPendingPluginPanelTarget(null);
  }, [pendingPluginPanelTarget, pluginTabGroups]);

  // Load plugin panel specs from /api/ui-specs and seed plugin-data-store.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchUiSpecs(sessionId)
      .then((specs) => {
        if (cancelled) return;

        // Surface server-side validation diagnostics for rejected specs so a
        // plugin author sees the exact plugin/field/problem in dev instead of
        // a panel silently missing its tab.
        if (import.meta.env.DEV && specs.diagnostics?.length) {
          for (const diag of specs.diagnostics) {
            const where = `${diag.pluginId} (${diag.runtimeId}) ${diag.slot}[${diag.specIndex}]${
              diag.specId ? ` "${diag.specId}"` : ""
            }`;
            const why = diag.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ");
            // eslint-disable-next-line no-console
            console.warn(`[ui-specs] dropped invalid spec — ${where}: ${why}`);
          }
        }

        setPluginTabGroups(
          aggregateSpecsIntoGroups(specs.right, i18n.language, {
            warn: (message) => {
              if (import.meta.env.DEV) {
                // eslint-disable-next-line no-console
                console.warn(message);
              }
            },
          }),
        );

        const pluginIds = new Set(specs.right.map((entry) => entry.pluginId));
        for (const pid of pluginIds) {
          listPluginData(sessionId, pid)
            .then((items) => {
              if (cancelled) return;
              const byNs = new Map<string, { key: string; value: unknown }[]>();
              for (const item of items) {
                const arr = byNs.get(item.namespace) ?? [];
                arr.push({ key: item.key, value: item.value });
                byNs.set(item.namespace, arr);
              }
              for (const [ns, entries] of byNs) {
                loadPluginData(pid, ns, entries);
              }
            })
            .catch(ignoreError("seed plugin data store"));
        }
      })
      .catch(ignoreError("fetch ui specs for right panel"));
    return () => {
      cancelled = true;
    };
  }, [sessionId, activePluginKey, i18n.language]);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex-1 flex min-h-0 min-w-0"
        orientation="vertical"
      >
        <div
          className="border-r border-(--rule-color) shrink-0 w-12 overflow-hidden"
          style={{
            background:
              "color-mix(in oklab, var(--surface-rail) 70%, var(--surface-page))",
          }}
        >
          <TabsList className="flex h-full w-full flex-col items-center justify-start rounded-none bg-transparent p-0 text-muted-foreground">
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
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
          <TabsContent value="world" className="p-4 m-0 max-w-full">
            <div className="mb-4 flex min-w-0 items-center gap-2 border-b border-(--rule-color) pb-3">
              <BookOpen className="w-4 h-4 shrink-0 text-muted-foreground" />
              <h3 className="ui-title text-sm font-semibold tracking-tight truncate">
                {t("session.worldTab")}
              </h3>
            </div>
            <WorldDocumentPanel world={world} />
          </TabsContent>
          <TabsContent value="database" className="p-4 m-0 max-w-full">
            <div className="mb-4 flex min-w-0 items-center gap-2 border-b border-(--rule-color) pb-3">
              <Database className="w-4 h-4 shrink-0 text-muted-foreground" />
              <h3 className="ui-title text-sm font-semibold tracking-tight truncate">
                {t("session.database")}
              </h3>
            </div>
            <DatabasePanel
              sessionId={sessionId}
              refreshKey={statePatches.length}
            />
          </TabsContent>

          {/* Dynamic plugin panel content (memory, codex, npc-graph, etc.) */}
          {pluginTabGroups.map((group) => {
            const subIdx = activePluginSubTab[group.id] ?? 0;
            const currentSub = group.subPanels[subIdx];
            const providerPlan = planPluginPanelProviders(group, subIdx);
            const GroupIcon = resolvePluginIcon(group.icon);

            return (
              <TabsContent
                key={`plugin-content-${group.id}`}
                value={`plugin-${group.id}`}
                className="p-4 m-0 max-w-full"
              >
                <div className="mb-3 flex min-w-0 items-center gap-2 border-b border-(--rule-color) pb-3">
                  <GroupIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                  <h3 className="ui-title text-sm font-semibold tracking-tight truncate">
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
                                setActivePluginSubTab((prev) => ({
                                  ...prev,
                                  [group.id]: firstIdx,
                                }));
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
                          key={sub.id}
                          type="button"
                          onClick={() =>
                            setActivePluginSubTab((prev) => ({
                              ...prev,
                              [group.id]: idx,
                            }))
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
                  <PluginPanel
                    key={currentSub.id}
                    pluginId={currentSub.pluginId}
                    spec={currentSub.spec}
                    stateCache={pluginPanelStateCacheRef.current}
                    enableDevtools={import.meta.env.DEV}
                  />
                )}
              </TabsContent>
            );
          })}
        </div>
      </Tabs>
      {storageStatus && (
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
