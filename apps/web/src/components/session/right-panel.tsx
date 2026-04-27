import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Database,
  PanelRightClose,
  BookOpen,
  HelpCircle,
} from "lucide-react";
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
import { DatabasePanel } from "./database-panel.js";
import {
  fetchServerHealth,
  fetchUiSpecs,
  listPluginData,
} from "@/services/api.js";
import type { UISlotEntry, WorldRecord } from "@/services/api.js";
import { resolveI18n } from "@/lib/catalog.js";
import { loadPluginData } from "@/stores/plugin-data-store.js";

// ── Plugin tab aggregation ───────────────────────────────────────

interface SubPanel {
  id: string;
  pluginId: string;
  label: string;
  icon: string;
  spec: Record<string, unknown>;
}

interface PluginTabGroup {
  id: string;
  label: string;
  icon: string;
  order: number;
  subPanels: SubPanel[];
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
 * Strip the common `core-` / `xxx-image-gen` boilerplate from a pluginId so
 * the duplicate-tab disambiguation stays short. Falls back to the raw id
 * when nothing matches.
 */
function shortPluginId(pluginId: string): string {
  const stripped = pluginId.replace(/^core-/, '').replace(/-image-gen$/, '');
  return stripped.length > 0 ? stripped : pluginId;
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

      const sub: SubPanel = {
        id: specId,
        pluginId: entry.pluginId,
        label: resolveI18n(spec.label, locale),
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
 * plugin contributions (core-char-creator "角色" and core-world-init
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
  const [storeBackend, setStoreBackend] = useState<string | null>(null);
  const [rawSlotEntries, setRawSlotEntries] = useState<UISlotEntry[]>([]);
  const [activePluginSubTab, setActivePluginSubTab] = useState<Record<string, number>>({});

  const pluginTabGroups = useMemo(
    () => aggregateSpecsIntoGroups(rawSlotEntries, i18n.language),
    [rawSlotEntries, i18n.language],
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
    return () => { cancelled = true; };
  }, [sessionId]);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
    <Tabs
      defaultValue="world"
      className="flex-1 flex min-h-0 min-w-0"
      orientation="vertical"
    >
      <div className="flex flex-col border-r border-border bg-background shrink-0 w-12 items-center py-2 gap-1">
        <TabsList className="flex flex-col rounded-none gap-1 bg-transparent h-auto p-0">
          {/* Section 1 — framework tabs */}
          <TabsTrigger
            value="world"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title={t("session.worldTab")}
          >
            <BookOpen className="w-4 h-4" />
            <span className="text-[9px] leading-none">
              {t("session.worldTab")}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="database"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title={t("session.database")}
          >
            <Database className="w-4 h-4" />
            <span className="text-[9px] leading-none">
              {t("session.database")}
            </span>
          </TabsTrigger>

          {/* Divider — only render when plugin tabs exist */}
          {pluginTabGroups.length > 0 && (
            <div
              aria-hidden
              className="w-6 h-px bg-border my-1.5"
            />
          )}

          {/* Section 2 — dynamic plugin tabs from /api/ui-specs */}
          {pluginTabGroups.map((group) => {
            const GroupIcon = resolvePluginIcon(group.icon);
            return (
              <TabsTrigger
                key={`plugin-${group.id}`}
                value={`plugin-${group.id}`}
                className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
                title={group.label}
              >
                <GroupIcon className="w-4 h-4" />
                <span className="text-[9px] leading-none truncate max-w-[36px]">
                  {group.label.slice(0, 4)}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
        <div className="mt-auto">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-sm"
            onClick={onToggleRightPanel}
          >
            <PanelRightClose className="w-4 h-4" />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0 min-w-0">
        <TabsContent value="world" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <BookOpen className="w-4 h-4 shrink-0" />{" "}
            {t("session.worldTab")}
          </h3>
          <WorldDocumentPanel world={world} />
        </TabsContent>
        <TabsContent value="database" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <Database className="w-4 h-4 shrink-0" />{" "}
            {t("session.database")}
          </h3>
          <DatabasePanel
            sessionId={sessionId}
            refreshKey={statePatches.length}
          />
        </TabsContent>

        {/* Dynamic plugin panel content (memory, codex, npc-graph, etc.) */}
        {pluginTabGroups.map((group) => {
          const subIdx = activePluginSubTab[group.id] ?? 0;
          const currentSub = group.subPanels[subIdx];
          return (
            <TabsContent key={`plugin-content-${group.id}`} value={`plugin-${group.id}`} className="p-4 m-0">
              <h3 className="font-display font-semibold flex items-center gap-2 mb-3 text-sm uppercase tracking-widest whitespace-nowrap">
                {group.label}
              </h3>
              {group.subPanels.length > 1 && (
                <div className="flex items-center gap-1 mb-3 border-b border-border pb-2 flex-wrap">
                  {group.subPanels.map((sub, idx) => {
                    const SubIcon = resolvePluginIcon(sub.icon);
                    const isActive = idx === subIdx;
                    // When multiple plugins contribute the same sub-label
                    // (e.g. dashscope-image-gen + openai-image-gen both
                    // declare a 画廊 panel under group: "image-studio"), the
                    // bare label produces indistinguishable duplicate tabs
                    // and the user can't tell which gallery is which.
                    // Suffix the pluginId only on the colliding tabs so
                    // the common single-plugin case stays clean.
                    const labelCollides =
                      group.subPanels.filter((other) => other.label === sub.label).length > 1;
                    const displayLabel = labelCollides
                      ? `${sub.label} · ${shortPluginId(sub.pluginId)}`
                      : sub.label;
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() =>
                          setActivePluginSubTab((prev) => ({ ...prev, [group.id]: idx }))
                        }
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium border-b-2 -mb-px transition-colors ${
                          isActive
                            ? "border-primary text-primary"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                        title={labelCollides ? sub.pluginId : undefined}
                      >
                        <SubIcon className="w-3 h-3" />
                        {displayLabel}
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
          {storeBackend === "pg" ? "PostgreSQL" : storeBackend === "sqlite" ? "SQLite" : "Memory"}
        </Badge>
        {storeBackend === "memory" && (
          <span className="text-amber-600 dark:text-amber-400">{t("session.memoryStoreWarning", "Data lost on restart")}</span>
        )}
      </div>
    )}
    </div>
  );
}
