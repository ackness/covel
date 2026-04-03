import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import {
  SlidersHorizontal, Database, MessageSquare, Settings2, History, Send,
  Code, LayoutTemplate, Loader2, AlertCircle, KeyRound, Plus,
  PanelLeftClose, PanelRightClose, BookOpen, MapIcon, Copy, Check, Gamepad2,
  Bug,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Toggle } from "@/components/ui/toggle.js";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { useMediaQuery } from "@/hooks/use-media-query.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { SettingsDialog } from "@/components/settings-dialog.js";
import { ActiveModelSlots } from "./active-model-slots.js";
import { SessionBreadcrumb } from "./session-breadcrumb.js";
import { getBlockRenderer } from "@/components/blocks/block-renderer.js";
import { ExecutionTimeline } from "./execution-timeline.js";
import { GameStatusPanel } from "./game-status-panel.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type { SessionRecord, WorldRecord, PackageSummary, PresetSummary, CommandSummary, LlmConfigResponse } from "@/services/api.js";

// ── Extracted Panel Components ──────────────────────────────────

interface LeftPanelProps {
  session: SessionRecord;
  phase: string;
  isLeftCollapsed: boolean;
  showSessionList: boolean;
  otherSessions: SessionRecord[];
  enabledPackages: PackageSummary[];
  commands: CommandSummary[];
  resolvedSlots: ResolvedSlot[];
  onToggleLeftPanel: () => void;
  onToggleSessionList: () => void;
  onSwitchSession: (session: SessionRecord) => void;
  onCloseSessionList: () => void;
  onOpenSettings: () => void;
  onResetSession: () => void;
}

function LeftPanel({
  session,
  phase,
  isLeftCollapsed,
  showSessionList,
  otherSessions,
  enabledPackages,
  commands,
  resolvedSlots,
  onToggleLeftPanel,
  onToggleSessionList,
  onSwitchSession,
  onCloseSessionList,
  onOpenSettings,
  onResetSession,
}: LeftPanelProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="h-14 px-3 border-b border-border bg-background flex items-center justify-between shrink-0">
        <h2 className="font-display font-bold text-sm uppercase tracking-widest flex items-center gap-2 whitespace-nowrap">
          <SlidersHorizontal className="w-4 h-4 shrink-0" />
          <span className={isLeftCollapsed ? "hidden" : "hidden sm:inline-block"}>
            {t("session.config", "Studio Config")}
          </span>
        </h2>
        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm ml-2 shrink-0" onClick={onToggleLeftPanel}>
          <PanelLeftClose className="w-4 h-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col">
          {/* ── Current Session ── */}
          <div className="px-3 py-2.5 border-b border-border space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <div className={`w-2 h-2 rounded-full shrink-0 ${session ? "bg-green-500 animate-pulse" : "bg-muted-foreground"}`} />
                <Badge variant="secondary" className="text-[10px]">{phase}</Badge>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={onToggleSessionList}
                title="Switch session"
              >
                <History className="w-3 h-3" />
              </Button>
            </div>
            <p className="text-[11px] font-mono text-foreground break-all leading-relaxed">
              {session.id}
            </p>
          </div>

          {/* ── Session List (expandable) ── */}
          {showSessionList && (
            <div className="px-3 py-2.5 border-b border-border space-y-1.5 bg-muted/20">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Sessions
              </h3>
              {otherSessions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">No other sessions</p>
              ) : (
                <div className="space-y-1">
                  {otherSessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => { onSwitchSession(s); onCloseSessionList(); }}
                      className="w-full text-left px-2 py-1.5 text-[11px] font-mono bg-background border border-border hover:border-primary/50 transition-colors truncate"
                    >
                      <span className="block truncate">{s.id}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {s.phase} · {new Date(s.createdAt).toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Models ── */}
          <div className="px-3 py-3 border-b border-border space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("session.activeModels", "Models")}
              </h3>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={onOpenSettings}
              >
                <Settings2 className="w-3 h-3" />
              </Button>
            </div>
            <ActiveModelSlots slots={resolvedSlots} variant="compact" />
          </div>

          {/* ── Plugins ── */}
          <div className="px-3 py-3 border-b border-border space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("session.plugins", "Plugins")}
            </h3>
            {enabledPackages.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No plugins loaded</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {enabledPackages.map((pkg) => (
                  <Badge key={pkg.name} variant="outline" className="text-[10px] border-primary/20">
                    {pkg.name}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* ── Commands ── */}
          {commands.length > 0 && (
            <div className="px-3 py-3 border-b border-border space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Commands
              </h3>
              <div className="space-y-0.5">
                {commands.map((cmd) => (
                  <div key={cmd.name} className="flex items-center gap-2 py-1 text-xs">
                    <span className="font-mono text-primary shrink-0">/{cmd.name}</span>
                    <span className="text-muted-foreground truncate text-[11px]">{cmd.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* ── Bottom Actions (sticky) ── */}
      <div className="px-3 py-2 border-t border-border bg-background shrink-0 space-y-1.5">
        <Button
          className="w-full rounded-none h-8 text-xs"
          variant="outline"
          onClick={onOpenSettings}
        >
          <KeyRound className="w-3.5 h-3.5 mr-1.5" />
          {t("nav.settings", "Settings")}
        </Button>
        <Button
          className="w-full rounded-none h-8 text-xs"
          variant="ghost"
          onClick={onResetSession}
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          New Session
        </Button>
      </div>
    </>
  );
}

interface RightPanelProps {
  world: WorldRecord | null;
  gameState: Record<string, unknown>;
  statePatches: Array<{ id: string; summary: string; packageName: string; data?: unknown }>;
  onToggleRightPanel: () => void;
}

function RightPanel({ world, gameState, statePatches, onToggleRightPanel }: RightPanelProps) {
  const { t } = useTranslation();

  return (
    <Tabs defaultValue="game" className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="h-14 px-2 border-b border-border bg-background flex items-center justify-between shrink-0">
        <TabsList className="grid w-full grid-cols-4 rounded-none flex-1 max-w-[320px]">
          <TabsTrigger value="game" className="text-xs uppercase tracking-widest">
            <Gamepad2 className="w-3 h-3 mr-1" />{t("session.game", "Game")}
          </TabsTrigger>
          <TabsTrigger value="state" className="text-xs uppercase tracking-widest">{t("session.state", "State")}</TabsTrigger>
          <TabsTrigger value="world" className="text-xs uppercase tracking-widest">{t("session.world", "World")}</TabsTrigger>
          <TabsTrigger value="records" className="text-xs uppercase tracking-widest">{t("session.lore", "Lore")}</TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-sm shrink-0 ml-2" onClick={onToggleRightPanel}>
          <PanelRightClose className="w-4 h-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <TabsContent value="game" className="p-4 m-0">
          <GameStatusPanel gameState={gameState} />
        </TabsContent>
        <TabsContent value="state" className="p-4 m-0 space-y-4">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <Database className="w-4 h-4 shrink-0" /> {t("session.statePatchesTitle", "State Patches")}
          </h3>
          {statePatches.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">{t("session.noStatePatches", "No state changes yet.")}</p>
          ) : (
            statePatches.map((patch) => (
              <Card key={patch.id}>
                <CardContent className="p-4 text-xs space-y-1">
                  <span className="font-medium">{patch.summary}</span>
                  <Badge variant="outline" className="text-[10px] ml-2">{patch.packageName}</Badge>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
        <TabsContent value="world" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <MapIcon className="w-4 h-4 shrink-0" /> {t("session.world", "World")}
          </h3>
          {world ? (
            <Card>
              <CardContent className="p-4 space-y-2">
                <span className="font-bold text-sm">{world.name}</span>
                <p className="text-muted-foreground text-xs">{world.description}</p>
                <span className="text-[10px] text-muted-foreground font-mono">{world.id}</span>
              </CardContent>
            </Card>
          ) : (
            <p className="text-xs text-muted-foreground italic">No world loaded.</p>
          )}
        </TabsContent>
        <TabsContent value="records" className="p-4 m-0">
          <h3 className="font-display font-semibold flex items-center gap-2 mb-4 text-sm uppercase tracking-widest whitespace-nowrap">
            <BookOpen className="w-4 h-4 shrink-0" /> {t("session.recordsTitle", "Records")}
          </h3>
          <p className="text-xs text-muted-foreground italic">{t("session.noRecords", "Long-term records will appear here as the story progresses.")}</p>
        </TabsContent>
      </ScrollArea>
    </Tabs>
  );
}

// ── Main Component ──────────────────────────────────────────────

interface GameViewProps {
  session: SessionRecord;
  world: WorldRecord | null;
  phase: string;
  messages: StreamMessage[];
  executing: boolean;
  executionError: string | null;
  packages: PackageSummary[];
  presets: PresetSummary[];
  commands: CommandSummary[];
  llmConfig?: LlmConfigResponse | null;
  statePatches: Array<{ id: string; summary: string; packageName: string; data?: unknown }>;
  gameState: Record<string, unknown>;
  executionSteps: ExecutionStep[];
  worldSessions: SessionRecord[];
  /** Block IDs that have been submitted (permanently locked). */
  submittedBlockIds: ReadonlySet<string>;
  onSendMessage: (content: string) => void;
  /** Mark a block as submitted (permanently locks it). */
  onSubmitBlock: (blockId: string) => void;
  /** Retry from a specific runtime (undefined = retry all). */
  onRetryRuntime?: (runtimeId?: string) => void;
  onResetSession: () => void;
  onBackToWorldSelect: () => void;
  onSwitchSession: (session: SessionRecord) => void;
  onLoadWorldSessions: () => void;
}

export function GameView({
  session,
  world,
  phase,
  messages,
  executing,
  executionError,
  packages,
  presets,
  commands,
  llmConfig,
  statePatches,
  gameState,
  executionSteps,
  worldSessions,
  submittedBlockIds,
  onSendMessage,
  onSubmitBlock,
  onRetryRuntime,
  onResetSession,
  onBackToWorldSelect,
  onSwitchSession,
  onLoadWorldSessions,
}: GameViewProps) {
  const { t } = useTranslation();
  const { resolvedSlots, refresh: refreshSlots } = useSlotConfig(presets, llmConfig);

  const [viewMode, setViewMode] = useState<"parsed" | "raw">("parsed");
  const [inputValue, setInputValue] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isMobile = useMediaQuery("(max-width: 768px)");
  const isTablet = useMediaQuery("(max-width: 1024px)");

  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
  const [isRightCollapsed, setIsRightCollapsed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const isLeftCollapsedRef = useRef(isLeftCollapsed);
  const isRightCollapsedRef = useRef(isRightCollapsed);
  isLeftCollapsedRef.current = isLeftCollapsed;
  isRightCollapsedRef.current = isRightCollapsed;

  useEffect(() => {
    if (isMobile || isTablet) {
      if (leftPanelRef.current && !isLeftCollapsedRef.current) leftPanelRef.current.collapse();
      if (rightPanelRef.current && !isRightCollapsedRef.current) rightPanelRef.current.collapse();
    }
  }, [isMobile, isTablet]);

  const toggleLeftPanel = () => {
    const panel = leftPanelRef.current;
    if (panel) { if (isLeftCollapsed) panel.expand(); else panel.collapse(); }
  };

  const toggleRightPanel = () => {
    const panel = rightPanelRef.current;
    if (panel) { if (isRightCollapsed) panel.expand(); else panel.collapse(); }
  };

  const handleSubmit = useCallback(() => {
    const val = inputValue.trim();
    if (!val || executing) return;
    onSendMessage(val);
    setInputValue("");
  }, [inputValue, executing, onSendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  }, [handleSubmit]);

  const handleSettingsOpenChange = (v: boolean) => {
    setSettingsOpen(v);
    if (!v) refreshSlots();
  };

  const direction = isMobile ? "vertical" : "horizontal";

  // ── Message Rendering ──────────────────────────────────────────

  function renderMessage(msg: StreamMessage) {
    if (msg.block) return renderBlock(msg);

    const isUser = msg.role === "user";
    const isSystem = msg.role === "system";

    return (
      <div key={msg.id} className={`flex flex-col gap-1.5 ${isUser ? "items-end" : ""}`}>
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
          {isUser ? "Player" : isSystem ? "System" : "Assistant"}
          {msg.turnId && <span className="ml-2 font-mono text-[10px]">{msg.turnId}</span>}
        </span>
        {viewMode === "parsed" ? (
          <div className={`border border-border p-4 text-sm break-words max-w-[90%] md:max-w-[85%] ${
            isUser ? "bg-primary text-primary-foreground" : "bg-card prose prose-sm dark:prose-invert max-w-none"
          }`}>
            {msg.content.split("\n").map((line, i) => (
              <p key={i} className={i > 0 ? "mt-2" : ""}>{line}</p>
            ))}
          </div>
        ) : (
          <div className="border border-border p-4 bg-muted/10 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all max-w-[90%] md:max-w-[85%]">
            {JSON.stringify({ role: msg.role, content: msg.content, turnId: msg.turnId }, null, 2)}
          </div>
        )}
      </div>
    );
  }

  function renderBlock(msg: StreamMessage) {
    const block = msg.block;
    if (!block) return null;
    const blockType = block.type as string;
    const data = block.data as Record<string, unknown> | undefined;
    const Renderer = getBlockRenderer(blockType);

    const hasCustomRenderer = viewMode === "parsed" && Renderer && data;
    const isSubmitted = submittedBlockIds.has(msg.id);
    const blockDisabled = executing || isSubmitted;

    const handleBlockSubmit = (value: string) => {
      onSubmitBlock(msg.id);
      onSendMessage(value);
    };

    return (
      <div key={msg.id} className="flex flex-col gap-1.5">
        {/* Hide label for interactive blocks with custom renderers (they're inline) */}
        {!hasCustomRenderer && (
          <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
            Block: {blockType}
          </span>
        )}
        {hasCustomRenderer ? (
          <Renderer data={data} onSubmit={handleBlockSubmit} disabled={blockDisabled} />
        ) : (
          <RawJsonBlock content={JSON.stringify(block, null, 2)} />
        )}
      </div>
    );
  }

  // ── Left Panel ─────────────────────────────────────────────────

  const enabledPackages = packages.filter((p) => p.enabled);
  const [showSessionList, setShowSessionList] = useState(false);
  const otherSessions = worldSessions.filter((s) => s.id !== session.id);

  const handleToggleSessionList = () => {
    if (!showSessionList) onLoadWorldSessions();
    setShowSessionList((v) => !v);
  };

  // ── Layout ─────────────────────────────────────────────────────

  return (
    <div className="flex h-full w-full overflow-hidden border-t border-border">
      <SettingsDialog open={settingsOpen} onOpenChange={handleSettingsOpenChange} />

      <ResizablePanelGroup direction={direction} className="w-full h-full">
        {/* Left Panel */}
        <ResizablePanel
          ref={leftPanelRef}
          defaultSize={isMobile ? 0 : 20}
          minSize={15}
          maxSize={isMobile ? 80 : 40}
          collapsible={true}
          collapsedSize={0}
          onCollapse={() => setIsLeftCollapsed(true)}
          onExpand={() => setIsLeftCollapsed(false)}
          className="bg-muted/10 flex flex-col min-h-0 min-w-0"
        >
          <LeftPanel
                session={session}
                phase={phase}
                isLeftCollapsed={isLeftCollapsed}
                showSessionList={showSessionList}
                otherSessions={otherSessions}
                enabledPackages={enabledPackages}
                commands={commands}
                resolvedSlots={resolvedSlots}
                onToggleLeftPanel={toggleLeftPanel}
                onToggleSessionList={handleToggleSessionList}
                onSwitchSession={onSwitchSession}
                onCloseSessionList={() => setShowSessionList(false)}
                onOpenSettings={() => setSettingsOpen(true)}
                onResetSession={onResetSession}
              />
        </ResizablePanel>

        <ResizableHandle withHandle className={isLeftCollapsed ? "hidden" : ""} />

        {/* Mobile: Right panel before center */}
        {isMobile && (
          <>
            <ResizablePanel
              ref={rightPanelRef}
              defaultSize={0}
              minSize={20}
              maxSize={80}
              collapsible={true}
              collapsedSize={0}
              onCollapse={() => setIsRightCollapsed(true)}
              onExpand={() => setIsRightCollapsed(false)}
              className="bg-muted/10 flex flex-col min-h-0 min-w-0"
            >
              <RightPanel
                world={world}
                gameState={gameState}
                statePatches={statePatches}
                onToggleRightPanel={toggleRightPanel}
              />
            </ResizablePanel>
            <ResizableHandle withHandle className={isRightCollapsed ? "hidden" : ""} />
          </>
        )}

        {/* Center Panel */}
        <ResizablePanel defaultSize={isMobile ? 100 : 55} minSize={isMobile ? 20 : 30} className="bg-background flex flex-col min-w-0 min-h-0">
          {/* Header */}
          <div className="h-14 px-3 border-b border-border flex justify-between items-center bg-background z-10 shrink-0">
            <div className="flex items-center gap-2 overflow-hidden">
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 rounded-sm shrink-0 ${!isLeftCollapsed && "bg-accent text-accent-foreground"}`}
                onClick={toggleLeftPanel}
              >
                <SlidersHorizontal className="w-4 h-4" />
              </Button>
              <SessionBreadcrumb
                step="game"
                worldName={world?.name}
                onGoWorldSelect={onBackToWorldSelect}
                onGoPrep={onResetSession}
                disabled={executing}
              />
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <div className="hidden sm:flex items-center border border-border rounded-md overflow-hidden">
                <Toggle pressed={viewMode === "parsed"} onPressedChange={() => setViewMode("parsed")} size="sm"
                  className="rounded-none border-0 h-7 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                  <LayoutTemplate className="w-3.5 h-3.5 mr-1.5" /><span className="text-xs">Parsed</span>
                </Toggle>
                <Toggle pressed={viewMode === "raw"} onPressedChange={() => setViewMode("raw")} size="sm"
                  className="rounded-none border-0 h-7 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                  <Code className="w-3.5 h-3.5 mr-1.5" /><span className="text-xs">Raw</span>
                </Toggle>
              </div>

              <div className="flex sm:hidden items-center border border-border rounded-md overflow-hidden">
                <Toggle pressed={viewMode === "parsed"} onPressedChange={() => setViewMode("parsed")} size="sm"
                  className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground" aria-label="Parsed view">
                  <LayoutTemplate className="w-3.5 h-3.5" />
                </Toggle>
                <Toggle pressed={viewMode === "raw"} onPressedChange={() => setViewMode("raw")} size="sm"
                  className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground" aria-label="Raw view">
                  <Code className="w-3.5 h-3.5" />
                </Toggle>
              </div>

              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-sm shrink-0" onClick={() => setSettingsOpen(true)} title="Settings">
                <KeyRound className="w-4 h-4" />
              </Button>

              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-sm shrink-0" asChild title="Debug Traces">
                <Link to="/debug" search={{ sid: session.id }}>
                  <Bug className="w-4 h-4" />
                </Link>
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 rounded-sm shrink-0 ${!isRightCollapsed && "bg-accent text-accent-foreground"}`}
                onClick={toggleRightPanel}
                title="Toggle State & World Context"
              >
                <Database className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4 md:p-6 space-y-6 md:space-y-8 max-w-4xl mx-auto w-full">
              {messages.length === 0 && !executing && (
                <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                  <MessageSquare className="w-8 h-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {phase === "init" && "正在准备冒险..."}
                    {phase === "character_creation" && "等待角色创建完成..."}
                    {phase === "playing" && "冒险等待着你，输入消息开始吧。"}
                    {phase === "ended" && "本次会话已结束。"}
                  </p>
                </div>
              )}

              {messages.map(renderMessage)}

              {executionSteps.length > 0 && (
                <ExecutionTimeline
                  steps={executionSteps}
                  executing={executing}
                  onRetryRuntime={onRetryRuntime ? (id) => onRetryRuntime(id) : undefined}
                  onRetryAll={onRetryRuntime ? () => onRetryRuntime(undefined) : undefined}
                />
              )}

              {executionError && (
                <div className="flex items-start gap-2 border border-destructive/50 bg-destructive/5 p-4 text-sm">
                  <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-destructive">Error</p>
                    <p className="text-xs text-muted-foreground mt-1 break-all">{executionError}</p>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {/* Input — always fixed at bottom */}
          <div className="p-3 md:p-4 border-t border-border bg-muted/5 shrink-0">
            {phase === "ended" ? (
              <p className="text-center text-sm text-muted-foreground">
                {t("session.ended", "This session has ended.")}
              </p>
            ) : (
              <div className="flex gap-2 max-w-4xl mx-auto">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    phase === "playing"
                      ? t("session.inputPlaceholder", "Enter action or command...")
                      : t("session.inputPlaceholderAny", "Send a message...")
                  }
                  disabled={executing}
                  className="flex-1 min-w-0 bg-background border border-border px-3 md:px-4 py-2 md:py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary transition-all disabled:opacity-50"
                />
                <Button
                  onClick={handleSubmit}
                  disabled={executing || !inputValue.trim()}
                  className="rounded-none px-4 md:px-6 h-auto shrink-0"
                  size="sm"
                >
                  {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
            )}
          </div>
        </ResizablePanel>

        {/* Desktop: Right panel */}
        {!isMobile && (
          <>
            <ResizableHandle withHandle className={isRightCollapsed ? "hidden" : ""} />
            <ResizablePanel
              ref={rightPanelRef}
              defaultSize={25}
              minSize={20}
              maxSize={50}
              collapsible={true}
              collapsedSize={0}
              onCollapse={() => setIsRightCollapsed(true)}
              onExpand={() => setIsRightCollapsed(false)}
              className="bg-muted/10 flex flex-col min-h-0 min-w-0"
            >
              <RightPanel
                world={world}
                gameState={gameState}
                statePatches={statePatches}
                onToggleRightPanel={toggleRightPanel}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}

function RawJsonBlock({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(copyTimerRef.current);
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative group border border-border bg-muted/10">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1 border border-border bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Copy"
      >
        {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
      </button>
      <pre className="p-4 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
        {content}
      </pre>
    </div>
  );
}
