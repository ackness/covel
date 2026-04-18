import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Database,
  PanelRightClose,
  BookOpen,
  MapIcon,
  Gamepad2,
  Library,
  User,
  Loader2,
  Download,
  RefreshCw,
  Layout,
} from "lucide-react";
import * as Icons from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Markdown } from "@/components/ui/markdown.js";
import { GameStatusPanel } from "./game-status-panel.js";
import { CharacterPanel } from "./character-panel.js";
import { WorldDimensionsPanel } from "./world-dimensions-panel.js";
import { LorebookPanel } from "./lorebook-panel.js";
import { PluginPanel } from "./plugin-panel.js";
import { text } from "@/components/world/editor-helpers.js";
import {
  fetchServerHealth,
  exportDimensionsUrl,
  syncSessionDimensions,
  fetchUiSpecs,
  listPluginData,
} from "@/services/api.js";
import type { WorldRecord, UISlotEntry } from "@/services/api.js";
import { useSession } from "@/stores/session-store.js";
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
  return (Icons as Record<string, unknown>)[pascal] as Icons.LucideIcon ?? Layout;
}

function aggregateSpecsIntoGroups(slotEntries: readonly UISlotEntry[]): PluginTabGroup[] {
  const groupMap = new Map<string, PluginTabGroup>();
  let counter = 0;

  for (const entry of slotEntries) {
    for (const spec of entry.specs) {
      const specId = spec.id ?? `${entry.pluginId}-${counter++}`;
      const groupKey = spec.group ?? `${entry.pluginId}::${specId}`;

      const sub: SubPanel = {
        id: specId,
        pluginId: entry.pluginId,
        label: resolveI18n(spec.label),
        icon: spec.icon ?? "layout",
        spec: spec as unknown as Record<string, unknown>,
      };

      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.subPanels.push(sub);
      } else {
        groupMap.set(groupKey, {
          id: groupKey,
          label: resolveI18n(spec.groupLabel) || sub.label,
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
  world: WorldRecord | null;
  gameState: Record<string, unknown>;
  pluginData: Record<string, Record<string, Record<string, unknown>>>;
  statePatches: Array<{
    id: string;
    summary: string;
    packageName: string;
    data?: unknown;
  }>;
  onToggleRightPanel: () => void;
}

export function RightPanel({
  sessionId,
  world,
  gameState,
  pluginData,
  statePatches,
  onToggleRightPanel,
}: RightPanelProps) {
  const { t } = useTranslation();
  const { state } = useSession();
  const [storeBackend, setStoreBackend] = useState<string | null>(null);
  const [characters, setCharacters] = useState<Array<Record<string, unknown>>>([]);
  const [pluginTabGroups, setPluginTabGroups] = useState<PluginTabGroup[]>([]);
  const [activePluginSubTab, setActivePluginSubTab] = useState<Record<string, number>>({});

  useEffect(() => {
    fetchServerHealth()
      .then((h) => setStoreBackend(h.storeBackend))
      .catch(() => {});
  }, []);

  // Character attribute schema from snapshot restore (gameState.characterSchema)
  const charAttrSchema = useMemo(() => {
    const gs = gameState.characterSchema;
    if (gs && typeof gs === "object") {
      return gs as Record<string, unknown>;
    }
    return null;
  }, [gameState.characterSchema]);

  // Load characters from API and merge with SSE gameState updates
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/sessions/${sessionId}/characters`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.items) setCharacters(data.items);
      })
      .catch(() => {});
  }, [sessionId]);

  // Sync characters from gameState (SSE updates)
  useEffect(() => {
    const gsChars = gameState.characters;
    if (!gsChars) return;
    const arr = Array.isArray(gsChars)
      ? gsChars as Array<Record<string, unknown>>
      : typeof gsChars === 'object'
        ? Object.entries(gsChars as Record<string, unknown>).map(([key, val]) => {
            const obj = (typeof val === 'object' && val !== null ? val : {}) as Record<string, unknown>;
            return obj.name ? obj : { ...obj, name: key };
          })
        : [];
    if (arr.length > 0) setCharacters(arr);
  }, [gameState.characters]);

  // Load plugin panel specs from /api/ui-specs and seed plugin-data-store
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchUiSpecs(sessionId)
      .then((specs) => {
        if (cancelled) return;
        const groups = aggregateSpecsIntoGroups(specs.right);
        setPluginTabGroups(groups);

        // Seed plugin-data-store with current data for each plugin panel.
        // This ensures panels render immediately even if SSE events were missed.
        const pluginIds = new Set(groups.flatMap((g) => g.subPanels.map((s) => s.pluginId)));
        for (const pid of pluginIds) {
          listPluginData(sessionId, pid)
            .then((items) => {
              if (cancelled) return;
              // Group items by namespace then bulk-load
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
      defaultValue="character"
      className="flex-1 flex min-h-0 min-w-0"
      orientation="vertical"
    >
      <div className="flex flex-col border-r border-border bg-background shrink-0 w-12 items-center py-2 gap-1">
        <TabsList className="flex flex-col rounded-none gap-1 bg-transparent h-auto p-0">
          <TabsTrigger
            value="game"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title={t("session.game", "Game")}
          >
            <Gamepad2 className="w-4 h-4" />
            <span className="text-[9px] leading-none">
              {t("session.game", "Game")}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="character"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title={t("session.character", "Character")}
          >
            <User className="w-4 h-4" />
            <span className="text-[9px] leading-none">
              {t("session.character", "角色")}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="state"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title={t("session.state", "State")}
          >
            <Database className="w-4 h-4" />
            <span className="text-[9px] leading-none">
              {t("session.state", "State")}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="world"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title={t("session.world", "World")}
          >
            <MapIcon className="w-4 h-4" />
            <span className="text-[9px] leading-none">
              {t("session.world", "World")}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="lorebook"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title="Lorebook"
          >
            <BookOpen className="w-4 h-4" />
            <span className="text-[9px] leading-none">Lore</span>
          </TabsTrigger>
          {/* Dynamic plugin tabs from /api/ui-specs (memory, codex, npc-graph, etc.) */}
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
        <TabsContent value="game" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <Gamepad2 className="w-4 h-4 shrink-0" />{" "}
            {t("session.game", "Game")}
          </h3>
          <GameStatusPanel gameState={gameState} />
        </TabsContent>
        <TabsContent value="character" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <User className="w-4 h-4 shrink-0" />{" "}
            {t("session.characterTitle", "角色状态")}
          </h3>
          <CharacterPanel
            characters={characters}
            schema={charAttrSchema}
          />
        </TabsContent>
        <TabsContent value="state" className="p-4 m-0 space-y-4">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <Database className="w-4 h-4 shrink-0" />{" "}
            {t("session.statePatchesTitle", "State Patches")}
          </h3>
          {statePatches.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              {t("session.noStatePatches", "No state changes yet.")}
            </p>
          ) : (
            statePatches.map((patch) => (
              <Card key={patch.id}>
                <CardContent className="p-4 text-xs space-y-1">
                  <span className="font-medium">{patch.summary}</span>
                  <Badge variant="outline" className="text-[10px] ml-2">
                    {patch.packageName}
                  </Badge>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
        <TabsContent value="world" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <MapIcon className="w-4 h-4 shrink-0" />{" "}
            {t("session.world", "世界观")}
            {world?.dimensions && (
              <a
                href={exportDimensionsUrl(world.id)}
                download
                className="ml-auto"
                title={t("session.exportDimensions", "导出维度")}
              >
                <Button variant="ghost" size="icon" className="h-6 w-6">
                  <Download className="w-3 h-3" />
                </Button>
              </a>
            )}
          </h3>
          {world ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-bold text-sm">{text(world.name)}</span>
                <span className="text-[10px] text-muted-foreground font-mono">{world.id}</span>
              </div>
              {/* Re-sync button — lets player pull latest world dimensions into this session */}
              {world.dimensions && sessionId && (
                <WorldSyncBanner
                  worldId={world.id}
                  sessionId={sessionId}
                />
              )}
              <p className="text-xs text-muted-foreground">
                {text(world.description)}
              </p>
              {world.dimensions && (
                <WorldDimensionsPanel dimensions={world.dimensions} />
              )}
              {world.lore && (
                <details className="group">
                  <summary className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                    {t("session.worldLore", "Lore")}
                  </summary>
                  <div className="prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed mt-2">
                    <Markdown>{text(world.lore)}</Markdown>
                  </div>
                </details>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {t("session.noWorldLoaded", "No world loaded.")}
            </p>
          )}
        </TabsContent>
        <TabsContent value="lorebook" className="p-4 m-0">
          <LorebookPanel sessionId={sessionId} />
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
              {/* Sub-tabs when group has multiple panels */}
              {group.subPanels.length > 1 && (
                <div className="flex items-center gap-1 mb-3 border-b border-border pb-2">
                  {group.subPanels.map((sub, idx) => {
                    const SubIcon = resolvePluginIcon(sub.icon);
                    const isActive = idx === subIdx;
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
                      >
                        <SubIcon className="w-3 h-3" />
                        {sub.label}
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
            storeBackend === "pg"
              ? "border-green-500/40 text-green-600 dark:text-green-400"
              : "border-amber-500/40 text-amber-600 dark:text-amber-400"
          }`}
        >
          {storeBackend === "pg" ? "PostgreSQL" : "Memory"}
        </Badge>
        {storeBackend === "memory" && (
          <span className="text-amber-600 dark:text-amber-400">{t("session.memoryStoreWarning", "Data lost on restart")}</span>
        )}
      </div>
    )}
    </div>
  );
}

// ── World Sync Banner ─────────────────────────────────────────────

function WorldSyncBanner({ worldId, sessionId }: { worldId: string; sessionId: string }) {
  const { t } = useTranslation();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await syncSessionDimensions(worldId, sessionId);
      setSyncResult(
        t("session.dimensionsSynced", "已同步 {{count}} 个维度", { count: result.entryCount }),
      );
    } catch {
      setSyncResult(t("session.dimensionsSyncFailed", "同步失败"));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        className="h-6 text-[10px] gap-1"
        onClick={handleSync}
        disabled={syncing}
      >
        {syncing ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <RefreshCw className="w-3 h-3" />
        )}
        {t("session.resyncDimensions", "重载维度")}
      </Button>
      {syncResult && (
        <span className="text-[10px] text-muted-foreground">{syncResult}</span>
      )}
    </div>
  );
}
