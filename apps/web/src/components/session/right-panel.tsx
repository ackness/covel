import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Database,
  PanelRightClose,
  BookOpen,
  MapIcon,
  Gamepad2,
  Flame,
  Library,
  User,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
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
import { GameStatusPanel } from "./game-status-panel.js";
import { CharacterPanel } from "./character-panel.js";
import { EventPanel } from "./event-panel.js";
import { CodexPanel } from "./codex-panel.js";
import { text } from "@/components/world/editor-helpers.js";
import { fetchServerHealth, listPluginData } from "@/services/api.js";
import type { WorldRecord, PluginDataEntry } from "@/services/api.js";
import { useSession } from "@/stores/session-store.js";

export interface RightPanelProps {
  sessionId: string;
  world: WorldRecord | null;
  gameState: Record<string, unknown>;
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
  statePatches,
  onToggleRightPanel,
}: RightPanelProps) {
  const { t } = useTranslation();
  const { state } = useSession();
  const [storeBackend, setStoreBackend] = useState<string | null>(null);
  const [characters, setCharacters] = useState<Array<Record<string, unknown>>>([]);
  const [worldSchema, setWorldSchema] = useState<PluginDataEntry[]>([]);
  const [worldEntries, setWorldEntries] = useState<PluginDataEntry[]>([]);
  const [worldDataLoading, setWorldDataLoading] = useState(false);
  const [worldDataLoaded, setWorldDataLoaded] = useState(false);

  useEffect(() => {
    fetchServerHealth()
      .then((h) => setStoreBackend(h.storeBackend))
      .catch(() => {});
  }, []);

  // Reset world data when session changes
  useEffect(() => {
    setWorldSchema([]);
    setWorldEntries([]);
    setWorldDataLoaded(false);
  }, [sessionId]);

  // Extract character attribute schema from loaded world data or gameState (snapshot restore)
  const charAttrSchema = useMemo(() => {
    // Priority 1: from plugin_data API (loaded by world tab)
    const entry = worldSchema.find((e) => e.key === "character-attributes");
    if (entry?.value && typeof entry.value === "object") {
      return entry.value as Record<string, unknown>;
    }
    // Priority 2: from snapshot restore (gameState.characterSchema)
    const gs = gameState.characterSchema;
    if (gs && typeof gs === "object") {
      return gs as Record<string, unknown>;
    }
    return null;
  }, [worldSchema, gameState.characterSchema]);

  // Discover world-data-provider plugin ID via capabilities (never hardcode plugin IDs)
  const worldDataPluginId = useMemo(() => {
    const plugin = state.sessionPlugins.find(
      (p) => p.isActive && p.capabilities?.includes("world-data-provider"),
    );
    return plugin?.id;
  }, [state.sessionPlugins]);

  // Fetch world dimension data when plugin is discovered
  const loadWorldData = useCallback(async () => {
    if (!sessionId || !worldDataPluginId || worldDataLoaded) return;
    setWorldDataLoading(true);
    try {
      const [schema, entries] = await Promise.all([
        listPluginData(sessionId, worldDataPluginId, "schema"),
        listPluginData(sessionId, worldDataPluginId, "entries"),
      ]);
      setWorldSchema(schema);
      setWorldEntries(entries);
      setWorldDataLoaded(true);
    } catch {
      // Non-critical: world data may not exist yet
    } finally {
      setWorldDataLoading(false);
    }
  }, [sessionId, worldDataPluginId, worldDataLoaded]);

  useEffect(() => {
    loadWorldData();
  }, [loadWorldData]);

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
            value="events"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title={t("session.events", "Events")}
          >
            <Flame className="w-4 h-4" />
            <span className="text-[9px] leading-none">
              {t("session.events", "Events")}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="codex"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title={t("session.codex", "Codex")}
          >
            <Library className="w-4 h-4" />
            <span className="text-[9px] leading-none">
              {t("session.codex", "Codex")}
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
            value="records"
            className="w-10 h-10 p-0 flex flex-col items-center justify-center gap-0.5"
            title={t("session.lore", "Lore")}
          >
            <BookOpen className="w-4 h-4" />
            <span className="text-[9px] leading-none">
              {t("session.lore", "Lore")}
            </span>
          </TabsTrigger>
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
        <TabsContent value="events" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <Flame className="w-4 h-4 shrink-0" />{" "}
            {t("session.eventsTitle", "Events")}
          </h3>
          <EventPanel gameState={gameState} />
        </TabsContent>
        <TabsContent value="codex" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <Library className="w-4 h-4 shrink-0" />{" "}
            {t("session.codexTitle", "Codex")}
          </h3>
          <CodexPanel gameState={gameState} />
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
            {t("session.world", "World")}
          </h3>
          {world ? (
            <div className="space-y-3">
              <Card>
                <CardContent className="p-4 space-y-2">
                  <span className="font-bold text-sm">{text(world.name)}</span>
                  <p className="text-muted-foreground text-xs">
                    {text(world.description)}
                  </p>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {world.id}
                  </span>
                </CardContent>
              </Card>
              {worldDataLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {t("session.loadingWorldData", "Loading world data...")}
                </div>
              )}
              {worldSchema.length > 0 && (
                <WorldDataSection
                  title={t("session.worldSchema", "Character Attributes")}
                  entries={worldSchema}
                />
              )}
              {worldEntries.length > 0 && (
                <WorldDataSection
                  title={t("session.worldEntries", "World Dimensions")}
                  entries={worldEntries}
                />
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              No world loaded.
            </p>
          )}
        </TabsContent>
        <TabsContent value="records" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <BookOpen className="w-4 h-4 shrink-0" />{" "}
            {t("session.recordsTitle", "Records")}
          </h3>
          <p className="text-xs text-muted-foreground italic">
            {t(
              "session.noRecords",
              "Long-term records will appear here as the story progresses.",
            )}
          </p>
        </TabsContent>
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

// ── World Data Section ──────────────────────────────────────────

/** Dimension name labels for well-known keys. */
const DIMENSION_LABELS: Record<string, string> = {
  geography: "Geography",
  factions: "Factions",
  history: "History",
  mechanics: "Mechanics",
  powerSystem: "Power System",
  socialStructure: "Social Structure",
  economy: "Economy",
  tone: "Tone & Atmosphere",
  startingConditions: "Starting Conditions",
  "character-attributes": "Character Attributes",
};

interface WorldDataSectionProps {
  title: string;
  entries: PluginDataEntry[];
}

function WorldDataSection({ title, entries }: WorldDataSectionProps) {
  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {entries.map((entry) => (
        <WorldDataEntryCard key={`${entry.namespace}/${entry.key}`} entry={entry} />
      ))}
    </div>
  );
}

function WorldDataEntryCard({ entry }: { entry: PluginDataEntry }) {
  const [expanded, setExpanded] = useState(false);
  const label = DIMENSION_LABELS[entry.key] ?? entry.key;
  const value = entry.value;

  // Special rendering for character-attributes schema
  if (entry.key === "character-attributes" && typeof value === "object" && value !== null) {
    const schema = value as Record<string, unknown>;
    const attrs = schema.attributes as Array<Record<string, unknown>> | undefined;
    if (attrs && Array.isArray(attrs)) {
      return (
        <Card>
          <CardContent className="p-3">
            <button
              type="button"
              className="w-full text-left flex items-center gap-2 hover:bg-muted/30 transition-colors"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded
                ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
              }
              <span className="text-xs font-medium">{label}</span>
              {!expanded && (
                <span className="text-[11px] text-muted-foreground">{attrs.length} 个属性</span>
              )}
            </button>
            {expanded && (
              <div className="mt-2 pl-5 space-y-1.5">
                {attrs.map((attr) => (
                  <div key={attr.id as string} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-medium text-foreground">{attr.name as string}</span>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[9px] rounded-none">{attr.type as string}</Badge>
                      <Badge variant="outline" className="text-[9px] rounded-none">{attr.category as string}</Badge>
                      {attr.defaultValue !== undefined && (
                        <span className="text-muted-foreground font-mono text-[10px]">={String(attr.defaultValue)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      );
    }
  }

  // For simple string values, show inline
  if (typeof value === "string") {
    return (
      <Card>
        <CardContent className="p-3">
          <button
            type="button"
            className="w-full text-left flex items-center gap-2 hover:bg-muted/30 transition-colors"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded
              ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
              : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
            }
            <span className="text-xs font-medium">{label}</span>
          </button>
          {expanded && (
            <p className="mt-2 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap pl-5">
              {value}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  // For object/array values, render key-value pairs or list items
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    // Extract a summary text from common fields
    const summary = typeof obj.description === "string"
      ? obj.description
      : typeof obj.summary === "string"
        ? obj.summary
        : null;

    return (
      <Card>
        <CardContent className="p-3">
          <button
            type="button"
            className="w-full text-left flex items-center gap-2 hover:bg-muted/30 transition-colors"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded
              ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
              : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
            }
            <span className="text-xs font-medium">{label}</span>
            {!expanded && summary && (
              <span className="text-[11px] text-muted-foreground truncate flex-1 min-w-0">
                {summary.length > 60 ? summary.slice(0, 60) + "..." : summary}
              </span>
            )}
          </button>
          {expanded && (
            <div className="mt-2 pl-5">
              <FormattedValue value={value} />
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // Fallback: simple scalar
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs">
          <span className="font-medium">{label}:</span>{" "}
          <span className="text-muted-foreground">{String(value)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Recursively render a value in a human-friendly format (no raw JSON). */
function FormattedValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <span className="text-muted-foreground">{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    // Simple string/number arrays → comma-separated badges
    if (value.every(v => typeof v === "string" || typeof v === "number")) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((item, i) => (
            <Badge key={i} variant="outline" className="text-[10px] rounded-none font-normal">
              {String(item)}
            </Badge>
          ))}
        </div>
      );
    }
    // Complex arrays → numbered list
    return (
      <div className={`space-y-1.5 ${depth > 0 ? "pl-3 border-l border-border/50" : ""}`}>
        {value.map((item, i) => (
          <div key={i} className="text-[11px]">
            {typeof item === "object" && item !== null
              ? <FormattedValue value={item} depth={depth + 1} />
              : <span className="text-muted-foreground">{String(item)}</span>}
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return (
      <div className={`space-y-1 ${depth > 0 ? "pl-3 border-l border-border/50" : ""}`}>
        {Object.entries(obj).map(([k, v]) => {
          const isComplex = typeof v === "object" && v !== null;
          return (
            <div key={k} className={isComplex ? "space-y-0.5" : "flex items-start gap-1.5"}>
              <span className="text-[11px] font-medium text-foreground shrink-0">
                {DIMENSION_LABELS[k] ?? k}{isComplex ? "" : ":"}
              </span>
              {isComplex ? (
                <FormattedValue value={v} depth={depth + 1} />
              ) : (
                <span className="text-[11px] text-muted-foreground">{String(v ?? "")}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return <span className="text-muted-foreground">{String(value)}</span>;
}
