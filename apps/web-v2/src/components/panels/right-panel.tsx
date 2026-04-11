/**
 * RightPanel — dynamic plugin panel tabs.
 *
 * Tabs are driven by /api/ui-specs. Each plugin that declares `ui.right`
 * gets a tab. The framework renders the panel using json-render.
 *
 * Fixed tabs: World (framework-owned)
 * Dynamic tabs: from plugins (json-render spec or custom React component)
 */

import { useState, useEffect } from "react";
import * as Icons from "lucide-react";
import { clsx } from "clsx";
import { fetchUiSpecs, type UISlotEntry } from "@/services/api.js";
import { PluginPanel } from "./plugin-panel.js";

interface PanelTab {
  id: string;
  pluginId: string;
  label: string;
  icon: string;
  spec: Record<string, unknown>;
  group?: string;
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

export function RightPanel() {
  const [tabs, setTabs] = useState<PanelTab[]>([]);
  const [activeTab, setActiveTab] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUiSpecs()
      .then((specs) => {
        const panelTabs: PanelTab[] = [];

        for (const entry of specs.right) {
          for (const spec of entry.specs) {
            const s = spec as Record<string, unknown>;
            panelTabs.push({
              id: s.id as string ?? `${entry.pluginId}-${panelTabs.length}`,
              pluginId: entry.pluginId,
              label: resolveI18n(s.label),
              icon: s.icon as string ?? "layout",
              spec: s,
              group: s.group as string | undefined,
            });
          }
        }

        setTabs(panelTabs);
        if (panelTabs.length > 0) {
          setActiveTab(panelTabs[0].id);
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("[RightPanel] Failed to load ui-specs:", err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400 text-xs">
        Loading panels...
      </div>
    );
  }

  if (tabs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400 text-xs">
        No plugin panels registered
      </div>
    );
  }

  const currentTab = tabs.find((t) => t.id === activeTab);

  return (
    <div className="flex h-full">
      {/* Activity bar — vertical icon strip */}
      <div className="flex flex-col items-center w-10 shrink-0 border-r border-zinc-200 dark:border-zinc-700 py-2 gap-1">
        {tabs.map((tab) => {
          const TabIcon = resolveIcon(tab.icon);
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              title={tab.label}
              onClick={() => setActiveTab(tab.id)}
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
              <TabIcon className="w-4 h-4" />
            </button>
          );
        })}
      </div>

      {/* Panel content */}
      <div className="flex-1 flex flex-col min-w-0">
        {currentTab && (
          <>
            <div className="shrink-0 px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                {currentTab.label}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <PluginPanel
                pluginId={currentTab.pluginId}
                spec={currentTab.spec}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
