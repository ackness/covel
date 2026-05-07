import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Database, BookOpen, HelpCircle, type LucideIcon } from "lucide-react";
import * as Icons from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { WorldDocumentPanel } from "./world-document-panel.js";
import { PluginPanel } from "./plugin-panel.js";
import type { PluginPanelStateCache } from "./plugin-panel.js";
import { DatabasePanel } from "./database-panel.js";
import {
  fetchServerHealth,
  fetchUiSpecs,
  listPluginData,
} from "@/services/api.js";
import type { UISlotEntry, WorldRecord } from "@/services/api.js";
import { resolveI18n } from "@/lib/catalog.js";
import { loadPluginData } from "@/stores/plugin-data-store.js";
import { useSession } from "@/stores/session-store.js";

// ── Plugin tab aggregation ───────────────────────────────────────

interface SubPanel {
  id: string;
  pluginId: string;
  label: string;
  shortLabel?: string;
  icon: string;
  spec: Record<string, unknown>;
}

interface PluginTabGroup {
  id: string;
  label: string;
  shortLabel?: string;
  icon: string;
  order: number;
  subPanels: SubPanel[];
}

interface RightPanelTabItem {
  id: string;
  value: string;
  label: string;
  shortLabel?: string;
  icon: LucideIcon;
  title?: string;
}

function resolvePluginIcon(name: string): Icons.LucideIcon {
  const pascal = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  const resolved = (Icons as Record<string, unknown>)[pascal] as
    | Icons.LucideIcon
    | undefined;
  if (resolved) return resolved;
  // Surface the mismatch loudly in dev so plugin authors notice mis-typed
  // icons without crashing the panel.
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      `[right-panel] unknown lucide icon "${name}" (looked up as "${pascal}") — falling back to HelpCircle`,
    );
  }
  return HelpCircle;
}

/**
 * Resolve a short, human-readable label for a plugin in the provider switcher
 * row. Prefers the manifest's locale-aware `displayName`; falls back to the
 * raw pluginId if no manifest is loaded yet. Framework code does not bake in
 * any plugin naming convention (e.g. `core-` prefix or `-image-gen` suffix).
 */
function pluginShortLabel(
  pluginId: string,
  sessionPlugins: readonly { id: string; displayName: unknown }[],
  locale: string,
): string {
  const plugin = sessionPlugins.find((p) => p.id === pluginId);
  if (!plugin) return pluginId;
  const label = resolveI18n(
    plugin.displayName as Parameters<typeof resolveI18n>[0],
    locale,
  );
  return label.length > 0 ? label : pluginId;
}

function compactTabLabel(label: string): string {
  const normalized = label.trim();
  if (!normalized) return "";

  const chars = Array.from(normalized);
  const hanChars = chars.filter((char) => /\p{Script=Han}/u.test(char));
  if (hanChars.length >= 2) return hanChars.slice(0, 2).join("");

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words
      .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
      .join("")
      .slice(0, 3);
  }

  return chars.slice(0, 4).join("");
}

function groupShortLabel(group: PluginTabGroup): string | undefined {
  return group.shortLabel;
}

function aggregateSpecsIntoGroups(
  slotEntries: readonly UISlotEntry[],
  locale: string,
): PluginTabGroup[] {
  const groupMap = new Map<string, PluginTabGroup>();
  let counter = 0;

  for (const entry of slotEntries) {
    for (const spec of entry.specs) {
      const specId = spec.id ?? `${entry.pluginId}-${counter++}`;
      const groupKey = spec.group ?? `${entry.pluginId}::${specId}`;

      const subShort = resolveI18n(spec.shortLabel, locale) || undefined;
      const sub: SubPanel = {
        id: specId,
        pluginId: entry.pluginId,
        label: resolveI18n(spec.label, locale),
        shortLabel: subShort,
        icon: spec.icon ?? "layout",
        spec: spec as unknown as Record<string, unknown>,
      };

      const existing = groupMap.get(groupKey);
      if (existing) {
        // Warn when two plugins share the same `group` but disagree on
        // `groupLabel`. The first-defined label wins (so tabs stay
        // stable) but the disagreement is surfaced so plugin authors
        // notice the collision during dev.
        const incomingLabel = resolveI18n(spec.groupLabel, locale);
        if (
          import.meta.env.DEV &&
          incomingLabel &&
          incomingLabel !== existing.label
        ) {
          // eslint-disable-next-line no-console
          console.warn(
            `[right-panel] plugin "${entry.pluginId}" declares group "${groupKey}" with label "${incomingLabel}", but group already exists with label "${existing.label}". Keeping first.`,
          );
        }
        existing.subPanels.push(sub);
      } else {
        groupMap.set(groupKey, {
          id: groupKey,
          label: resolveI18n(spec.groupLabel, locale) || sub.label,
          shortLabel: subShort,
          icon: sub.icon,
          order: spec.groupOrder ?? 500,
          subPanels: [sub],
        });
      }
    }
  }

  return Array.from(groupMap.values()).sort((a, b) => a.order - b.order);
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
  onToggleRightPanel: () => void;
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
  onToggleRightPanel,
}: RightPanelProps) {
  const { t, i18n } = useTranslation();
  const pluginPanelStateCacheRef = useRef<PluginPanelStateCache>(new Map());
  const [storeBackend, setStoreBackend] = useState<string | null>(null);
  const [rawSlotEntries, setRawSlotEntries] = useState<UISlotEntry[]>([]);
  const [activePluginSubTab, setActivePluginSubTab] = useState<
    Record<string, number>
  >({});
  const { state: sessionState } = useSession();
  const activePluginKey = useMemo(
    () =>
      sessionState.sessionPlugins
        .filter((plugin) => plugin.isActive)
        .map((plugin) => plugin.id)
        .sort()
        .join("\u001f"),
    [sessionState.sessionPlugins],
  );

  const pluginTabGroups = useMemo(
    () => aggregateSpecsIntoGroups(rawSlotEntries, i18n.language),
    [rawSlotEntries, i18n.language],
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
      .then((h) => setStoreBackend(h.storeBackend))
      .catch(() => {});
  }, []);

  // Load plugin panel specs from /api/ui-specs and seed plugin-data-store.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchUiSpecs(sessionId)
      .then((specs) => {
        if (cancelled) return;
        setRawSlotEntries([...specs.right]);

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
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, activePluginKey]);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <Tabs
        defaultValue="world"
        className="flex-1 flex min-h-0 min-w-0"
        orientation="vertical"
      >
        <div
          className="border-r border-[var(--rule-color)] shrink-0 w-12 overflow-hidden"
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
                    className="group relative h-11 w-full rounded-none border-0 px-0 py-0 text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                    title={item.title ?? item.label}
                    aria-label={item.label}
                  >
                    <span
                      aria-hidden
                      className="absolute left-0 top-1 bottom-1 w-[2px] bg-transparent transition-colors group-data-[state=active]:bg-[var(--accent-primary)]"
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
        <ScrollArea className="flex-1 min-h-0 min-w-0">
          <TabsContent value="world" className="p-4 m-0 max-w-full">
            <div className="flex items-center gap-2 mb-4 min-w-0">
              <BookOpen className="w-4 h-4 shrink-0 text-muted-foreground" />
              <h3 className="ui-title text-sm font-semibold tracking-tight truncate">
                {t("session.worldTab")}
              </h3>
            </div>
            <WorldDocumentPanel world={world} />
          </TabsContent>
          <TabsContent value="database" className="p-4 m-0 max-w-full">
            <div className="flex items-center gap-2 mb-4 min-w-0">
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
            // Group sub-panels by pluginId so that when multiple plugins
            // contribute the same group (e.g. dashscope-image-gen +
            // openai-image-gen both publish a 画廊/任务/生成 trio under
            // image-studio), we render a 2-tier picker:
            //   row 1 = provider segmented control
            //   row 2 = sub-panel chips for that provider
            // This avoids the awful flat list of "画廊·dashscope, 任务·dashscope,
            // 生成·dashscope, 画廊·openai, 任务·openai, 生成·openai".
            const byProvider = new Map<
              string,
              { pluginId: string; subs: { sub: SubPanel; idx: number }[] }
            >();
            group.subPanels.forEach((sub, idx) => {
              if (!byProvider.has(sub.pluginId)) {
                byProvider.set(sub.pluginId, {
                  pluginId: sub.pluginId,
                  subs: [],
                });
              }
              byProvider.get(sub.pluginId)!.subs.push({ sub, idx });
            });
            const providers = [...byProvider.values()];
            const multiProvider = providers.length > 1;
            const activeProviderId =
              currentSub?.pluginId ?? providers[0]?.pluginId;
            const activeProviderSubs =
              byProvider.get(activeProviderId)?.subs ?? [];
            const GroupIcon = resolvePluginIcon(group.icon);

            return (
              <TabsContent
                key={`plugin-content-${group.id}`}
                value={`plugin-${group.id}`}
                className="p-4 m-0 max-w-full"
              >
                <div className="flex items-center gap-2 mb-3 min-w-0">
                  <GroupIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                  <h3 className="ui-title text-sm font-semibold tracking-tight truncate">
                    {group.label}
                  </h3>
                </div>

                {/* Provider switcher — only when 2+ plugins share the group */}
                {multiProvider && (
                  <div className="flex items-center gap-2 mb-2 ui-meta text-[10px] text-muted-foreground">
                    <span>provider</span>
                    <div className="flex items-center border border-[var(--rule-color)] rounded-[var(--radius-control)] overflow-hidden">
                      {providers.map((p) => {
                        const isActive = p.pluginId === activeProviderId;
                        return (
                          <button
                            key={p.pluginId}
                            type="button"
                            onClick={() => {
                              // jump to first sub-panel of this provider
                              const firstIdx = byProvider.get(p.pluginId)!
                                .subs[0]?.idx;
                              if (typeof firstIdx === "number") {
                                setActivePluginSubTab((prev) => ({
                                  ...prev,
                                  [group.id]: firstIdx,
                                }));
                              }
                            }}
                            className={`px-2 py-0.5 text-[10px] font-medium tracking-wider transition-colors max-w-[10rem] truncate ${
                              isActive
                                ? "bg-foreground text-[var(--surface-page)]"
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
                {(activeProviderSubs.length > 1 ||
                  (!multiProvider && group.subPanels.length > 1)) && (
                  <div className="flex items-center gap-2 mb-3 border-b border-[var(--rule-color)] pb-2 flex-wrap">
                    {(multiProvider
                      ? activeProviderSubs
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
                              ? "border-[var(--accent-primary)] text-foreground"
                              : "border-transparent text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <SubIcon className="w-3 h-3" />
                          <span className="truncate max-w-[8rem]">
                            {sub.label}
                          </span>
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
                  />
                )}
              </TabsContent>
            );
          })}
        </ScrollArea>
      </Tabs>
      {storeBackend && (
        <div className="border-t border-border px-3 py-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          <Database className="w-3 h-3" />
          <span>Store:</span>
          <Badge
            variant="outline"
            className={`text-[9px] rounded-none ${
              storeBackend === "pg" || storeBackend === "sqlite"
                ? "border-green-500/40 text-green-600 dark:text-green-400"
                : "border-amber-500/40 text-amber-600 dark:text-amber-400"
            }`}
          >
            {storeBackend === "pg"
              ? "PostgreSQL"
              : storeBackend === "sqlite"
                ? "SQLite"
                : "Memory"}
          </Badge>
          {storeBackend === "memory" && (
            <span className="text-amber-600 dark:text-amber-400">
              {t("session.memoryStoreWarning", "Data lost on restart")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function panelProviderLabel(
  pluginId: string,
  groupId: string,
  subPanels: readonly SubPanel[],
  sessionPlugins: readonly { id: string; displayName: unknown }[],
  locale: string,
): string {
  if (groupId === "chat-mode" && subPanels.length > 0) {
    const first = subPanels[0];
    return first.shortLabel ?? first.label;
  }
  return pluginShortLabel(pluginId, sessionPlugins, locale);
}
