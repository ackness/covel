import { useState, useEffect } from "react";
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
import { EventPanel } from "./event-panel.js";
import { CodexPanel } from "./codex-panel.js";
import { text } from "@/components/world/editor-helpers.js";
import { fetchServerHealth } from "@/services/api.js";
import type { WorldRecord } from "@/services/api.js";

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
  const [storeBackend, setStoreBackend] = useState<string | null>(null);
  const [characters, setCharacters] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    fetchServerHealth()
      .then((h) => setStoreBackend(h.storeBackend))
      .catch(() => {});
  }, []);

  // Load characters from API and merge with SSE gameState updates
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/sessions/${sessionId}/characters`)
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
          {characters.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              {t("session.noCharacters", "角色信息将在创建角色后显示。")}
            </p>
          ) : (
            <div className="space-y-3">
              <GameStatusPanel gameState={{ characters }} />
            </div>
          )}
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
