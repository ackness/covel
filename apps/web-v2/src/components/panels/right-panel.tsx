/**
 * RightPanel — dynamic plugin panel tabs.
 *
 * Tabs are driven by /api/ui-specs. Each plugin spec becomes a SubPanel.
 * Sub-panels sharing the same `group` field are merged into a single outer
 * tab in the activity bar, with a horizontal sub-tab bar inside to switch
 * between them.
 *
 * Group is a **global key** — two different plugins can contribute panels
 * to the same outer tab by declaring the same `group` value (e.g. core-char-creator
 * and a future core-inventory both using `group: "character"`). This enables
 * composable sidebar surfaces where an ecosystem of plugins augments the
 * same conceptual area. Sub-panels from different plugins appear as sibling
 * sub-tabs in plugin load order (backend order from /api/ui-specs).
 *
 * Conflict resolution: when multiple specs share a group, the outer tab
 * uses the *first* spec's `groupLabel` (falling back to `label`), `icon`,
 * and `groupOrder`. Later contributors can still set these fields but the
 * first wins. This is an intentional "first come first served" policy —
 * plugin authors are expected to use namespaced group keys (`core.character`,
 * `myorg.combat`) to avoid collisions, like CSS class names.
 */

import { useMemo, useState, useEffect } from "react";
import * as Icons from "lucide-react";
import { clsx } from "clsx";
import { fetchUiSpecs, type UISlotEntry } from "@/services/api.js";
import { useSessionStore } from "@/stores/session-store.js";
import { PluginPanel } from "./plugin-panel.js";
import { LorebookPanel } from "./lorebook-panel.js";

/**
 * Framework-owned tab identifiers. These sit alongside plugin-driven tab
 * groups in the activity bar but are rendered by hardcoded React components
 * rather than json-render specs, because the underlying capability is owned
 * by the framework (not a plugin).
 */
const FRAMEWORK_TAB_LOREBOOK = "__framework__::lorebook";

interface SubPanel {
  id: string;
  pluginId: string;
  label: string;
  icon: string;
  spec: Record<string, unknown>;
}

interface TabGroup {
  /**
   * Globally unique outer-tab id. When specs declare a `group` field, the id
   * equals the group value (shared across plugins). Otherwise it falls back to
   * `${pluginId}::${specId}` so ungrouped panels stay independent.
   */
  id: string;
  /** Outer activity-bar label (first contributor's groupLabel → label) */
  label: string;
  /** Outer activity-bar icon (first contributor's icon) */
  icon: string;
  /** Sort order for activity bar position (first contributor's groupOrder, default 500) */
  order: number;
  subPanels: SubPanel[];
}

function resolveIcon(name: string): Icons.LucideIcon {
  const pascal = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return (Icons as Record<string, unknown>)[pascal] as Icons.LucideIcon ?? Icons.Layout;
}

function resolveI18n(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, string>;
    return obj["zh"] ?? obj["zh-CN"] ?? obj["en"] ?? Object.values(obj)[0] ?? "";
  }
  return String(value ?? "");
}

/**
 * Aggregate flat ui-specs into TabGroups.
 *
 * Specs with the same `group` key merge into one TabGroup (cross-plugin).
 * Specs without `group` fall back to `${pluginId}::${specId}` as a unique
 * key so they stay independent.
 *
 * Pure function — exported for testability.
 */
export function aggregateSpecsIntoGroups(
  slotEntries: readonly UISlotEntry[],
): TabGroup[] {
  const groupMap = new Map<string, TabGroup>();
  let counter = 0;

  for (const entry of slotEntries) {
    for (const spec of entry.specs) {
      const s = spec as Record<string, unknown>;
      const specId = (s.id as string) ?? `${entry.pluginId}-${counter++}`;
      const groupKey = (s.group as string | undefined) ?? `${entry.pluginId}::${specId}`;

      const sub: SubPanel = {
        id: specId,
        pluginId: entry.pluginId,
        label: resolveI18n(s.label),
        icon: (s.icon as string) ?? "layout",
        spec: s,
      };

      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.subPanels.push(sub);
      } else {
        groupMap.set(groupKey, {
          id: groupKey,
          label: resolveI18n(s.groupLabel) || sub.label,
          icon: sub.icon,
          order: (s.groupOrder as number | undefined) ?? 500,
          subPanels: [sub],
        });
      }
    }
  }

  // Sort by groupOrder, then by insertion order (stable Map iteration)
  return Array.from(groupMap.values()).sort((a, b) => a.order - b.order);
}

export function RightPanel() {
  const { session } = useSessionStore();
  const sessionId = session?.id;
  const [rawGroups, setRawGroups] = useState<TabGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [activeSubByGroup, setActiveSubByGroup] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Reset local tab state on session switch so the previous session's
    // tabs don't briefly flash before the new specs arrive.
    setRawGroups([]);
    setActiveGroupId("");
    setActiveSubByGroup({});

    fetchUiSpecs(sessionId)
      .then((specs) => {
        if (cancelled) return;
        const groups = aggregateSpecsIntoGroups(specs.right);
        setRawGroups(groups);
        if (groups.length > 0) setActiveGroupId(groups[0].id);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[RightPanel] Failed to load ui-specs:", err);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const currentGroup = useMemo(
    () => rawGroups.find((g) => g.id === activeGroupId),
    [rawGroups, activeGroupId],
  );
  const activeSubIdx = activeSubByGroup[activeGroupId] ?? 0;
  const currentSub = currentGroup?.subPanels[activeSubIdx];
  const isFrameworkTabActive = activeGroupId === FRAMEWORK_TAB_LOREBOOK;
  const hasSession = Boolean(sessionId);

  // On first paint for a new session, prefer the first plugin tab if present;
  // otherwise fall back to the framework Lorebook tab so the panel is never
  // empty once a session exists.
  useEffect(() => {
    if (!activeGroupId && !loading && hasSession && rawGroups.length === 0) {
      setActiveGroupId(FRAMEWORK_TAB_LOREBOOK);
    }
  }, [activeGroupId, loading, hasSession, rawGroups.length]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400 text-xs">
        Loading panels...
      </div>
    );
  }

  // Lorebook is always available when a session exists, even if no plugin
  // panels are registered. Only show the "no panels" message for the
  // pre-session state.
  if (!hasSession && rawGroups.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400 text-xs">
        No plugin panels registered
      </div>
    );
  }

  const LorebookIcon = resolveIcon("book-open");

  return (
    <div className="flex h-full">
      {/* Activity bar — vertical icon strip (one icon per group + framework tabs) */}
      <div className="flex flex-col items-center w-10 shrink-0 border-r border-zinc-200 dark:border-zinc-700 py-2 gap-1">
        {rawGroups.map((group) => {
          const GroupIcon = resolveIcon(group.icon);
          const isActive = group.id === activeGroupId;
          return (
            <button
              key={group.id}
              type="button"
              title={group.label}
              onClick={() => setActiveGroupId(group.id)}
              className={clsx(
                "relative flex items-center justify-center w-8 h-8 rounded-md transition-colors",
                isActive
                  ? "bg-zinc-100 dark:bg-zinc-800 text-blue-600 dark:text-blue-400"
                  : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50",
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-blue-500" />
              )}
              <GroupIcon className="w-4 h-4" />
            </button>
          );
        })}

        {/* Framework-owned: Lorebook (always visible when a session exists) */}
        {hasSession && (
          <button
            type="button"
            title="Lorebook"
            onClick={() => setActiveGroupId(FRAMEWORK_TAB_LOREBOOK)}
            className={clsx(
              "relative flex items-center justify-center w-8 h-8 rounded-md transition-colors",
              isFrameworkTabActive
                ? "bg-zinc-100 dark:bg-zinc-800 text-blue-600 dark:text-blue-400"
                : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50",
            )}
          >
            {isFrameworkTabActive && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-blue-500" />
            )}
            <LorebookIcon className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Panel content */}
      <div className="flex-1 flex flex-col min-w-0">
        {isFrameworkTabActive && sessionId ? (
          <LorebookPanel key={sessionId} sessionId={sessionId} />
        ) : currentGroup ? (
          <>
            <div className="shrink-0 px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                {currentGroup.label}
              </span>
            </div>

            {/* Horizontal sub-tabs (only when group has >1 sub-panel) */}
            {currentGroup.subPanels.length > 1 && (
              <div className="shrink-0 flex items-center gap-1 px-2 pt-2 border-b border-zinc-200 dark:border-zinc-700">
                {currentGroup.subPanels.map((sub, idx) => {
                  const SubIcon = resolveIcon(sub.icon);
                  const isActive = idx === activeSubIdx;
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() =>
                        setActiveSubByGroup((prev) => ({ ...prev, [activeGroupId]: idx }))
                      }
                      className={clsx(
                        "flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium border-b-2 -mb-px transition-colors",
                        isActive
                          ? "border-blue-500 text-blue-600 dark:text-blue-400"
                          : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300",
                      )}
                    >
                      <SubIcon className="w-3 h-3" />
                      {sub.label}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3">
              {currentSub && (
                <PluginPanel
                  key={currentSub.id}
                  pluginId={currentSub.pluginId}
                  spec={currentSub.spec}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-400 text-xs">
            Select a tab
          </div>
        )}
      </div>
    </div>
  );
}
