import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import {
  SlidersHorizontal,
  Database,
  Send,
  Code,
  LayoutTemplate,
  Loader2,
  KeyRound,
  Check,
  Bug,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Toggle } from "@/components/ui/toggle.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useMediaQuery } from "@/hooks/use-media-query.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { SettingsDialog } from "@/components/settings-dialog.js";
import { SessionBreadcrumb } from "./session-breadcrumb.js";
import { ChatMessages } from "./chat-messages.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
import { useSession } from "@/stores/session-store.js";
import type {
  SessionRecord,
  WorldRecord,
  PackageSummary,
  PresetSummary,
  CommandSummary,
  LlmConfigResponse,
  PluginLoadError,
  SessionPluginInfo,
} from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import { LeftPanel } from "./left-panel.js";
import { RightPanel } from "./right-panel.js";

// ── Extracted Panel Components (see left-panel.tsx, right-panel.tsx) ──

// ── Main Component ──────────────────────────────────────────────

interface GameViewProps {
  session: SessionRecord;
  world: WorldRecord | null;
  phase: string;
  messages: StreamMessage[];
  executing: boolean;
  executionError: string | null;
  packages: PackageSummary[];
  pluginLoadErrors: PluginLoadError[];
  /** Session-scoped plugin list with live isActive state. */
  sessionPlugins: SessionPluginInfo[];
  presets: PresetSummary[];
  commands: CommandSummary[];
  llmConfig?: LlmConfigResponse | null;
  statePatches: Array<{
    id: string;
    summary: string;
    packageName: string;
    data?: unknown;
  }>;
  gameState: Record<string, unknown>;
  pluginData: Record<string, Record<string, Record<string, unknown>>>;
  executionSteps: ExecutionStep[];
  worldSessions: SessionRecord[];
  /** Block IDs that have been submitted (permanently locked). */
  submittedBlockIds: ReadonlySet<string>;
  /** Kick off the narrative — called when player clicks 开始冒险. */
  onBeginAdventure: () => void;
  onSendMessage: (content: string) => void;
  /** Mark a block as submitted (permanently locks it). */
  onSubmitBlock: (blockId: string) => void;
  /** Submit an interactive block through submit-inputs API. */
  onSubmitInteraction?: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: 'form' | 'choice' | 'confirmation',
    values: Record<string, unknown>,
    submitBehavior?: { autoContinue?: boolean; echoFilledNarrative?: boolean },
  ) => Promise<void>;
  /** Retry from a specific runtime (undefined = retry all). */
  onRetryRuntime?: (runtimeId?: string) => void;
  onResetSession: () => void;
  onBackToWorldSelect: () => void;
  onSwitchSession: (session: SessionRecord) => void;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onLoadWorldSessions: () => void;
  /** Load session-scoped plugin list from the server. */
  onLoadSessionPlugins: () => Promise<void>;
  /** Enable or disable a plugin for the current session. */
  onTogglePlugin: (pluginId: string, enable: boolean) => Promise<void>;
  /** Trigger a custom kernel event (e.g. image generation from a message). */
  onTriggerEvent?: (eventType: string, eventData: Record<string, unknown>) => void;
}

export function GameView({
  session,
  world,
  phase,
  messages,
  executing,
  executionError,
  packages,
  pluginLoadErrors,
  sessionPlugins,
  presets,
  commands,
  llmConfig,
  statePatches,
  gameState,
  pluginData,
  executionSteps,
  worldSessions,
  submittedBlockIds,
  onBeginAdventure,
  onSendMessage,
  onSubmitBlock,
  onSubmitInteraction,
  onRetryRuntime,
  onResetSession,
  onBackToWorldSelect,
  onSwitchSession,
  onDeleteSession,
  onLoadWorldSessions,
  onLoadSessionPlugins,
  onTogglePlugin,
  onTriggerEvent,
}: GameViewProps) {
  const { t } = useTranslation();
  const { resolvedSlots, refresh: refreshSlots } = useSlotConfig(
    presets,
    llmConfig,
  );

  const [viewMode, setViewMode] = useState<"parsed" | "raw">("parsed");
  const [inputValue, setInputValue] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Legacy blockSelections path is kept only to satisfy ChatMessages' prop
  // contract (some older blocks still wire onSelect). The "confirm & send"
  // bar below is driven by pendingInteractionDrafts (V2 flow) instead.
  const [blockSelections, setBlockSelections] = useState<Record<string, string>>({});

  const handleBlockSelect = useCallback((blockId: string, value: string) => {
    setBlockSelections((prev) => ({ ...prev, [blockId]: value }));
  }, []);

  // ── Unified draft send — pending interaction drafts ──────────────
  // Plugin-declared buttons (guide suggestions, draftMessage actions) push
  // drafts into the session store. The confirm bar materialises them here.
  const { state: sessionState, clearInteractionDrafts, removeInteractionDraft } = useSession();
  const pendingDrafts = sessionState.pendingInteractionDrafts;

  const handleConfirmDrafts = useCallback(() => {
    if (pendingDrafts.length === 0) return;
    const combined = pendingDrafts
      .map((d) => String(d.values?.text ?? d.label ?? "").trim())
      .filter(Boolean)
      .join("\n");
    if (!combined) {
      clearInteractionDrafts();
      return;
    }
    onSendMessage(combined);
    clearInteractionDrafts();
    setBlockSelections({});
  }, [pendingDrafts, clearInteractionDrafts, onSendMessage]);

  // Load session-scoped plugin list whenever the session changes.
  useEffect(() => {
    onLoadSessionPlugins().catch(() => {});
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isMobile = useMediaQuery("(max-width: 768px)");
  const isTablet = useMediaQuery("(max-width: 1024px)");

  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
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
      if (leftPanelRef.current && !isLeftCollapsedRef.current)
        leftPanelRef.current.collapse();
      if (rightPanelRef.current && !isRightCollapsedRef.current)
        rightPanelRef.current.collapse();
    }
  }, [isMobile, isTablet]);

  const toggleLeftPanel = () => {
    const panel = leftPanelRef.current;
    if (panel) {
      if (isLeftCollapsed) panel.expand();
      else panel.collapse();
    }
  };

  const toggleRightPanel = () => {
    const panel = rightPanelRef.current;
    if (panel) {
      if (isRightCollapsed) panel.expand();
      else panel.collapse();
    }
  };

  const handleSubmit = useCallback(() => {
    const val = inputValue.trim();
    if (!val || executing) return;
    onSendMessage(val);
    setInputValue("");
  }, [inputValue, executing, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleSettingsOpenChange = (v: boolean) => {
    setSettingsOpen(v);
    if (!v) refreshSlots();
  };

  const direction = isMobile ? "vertical" : "horizontal";

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
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={handleSettingsOpenChange}
      />

      <ResizablePanelGroup id="game-layout" orientation={direction} className="w-full h-full">
        {/* Left Panel */}
        <ResizablePanel
          id="left-panel"
          panelRef={leftPanelRef}
          defaultSize={isMobile ? "0%" : "20%"}
          minSize="15%"
          maxSize={isMobile ? "80%" : "40%"}
          collapsible={true}
          collapsedSize="0%"
          onResize={() => setIsLeftCollapsed(leftPanelRef.current?.isCollapsed() ?? false)}
          className="bg-muted/10 flex flex-col min-h-0 min-w-0"
        >
          <LeftPanel
            session={session}
            phase={phase}
            isLeftCollapsed={isLeftCollapsed}
            showSessionList={showSessionList}
            otherSessions={otherSessions}
            enabledPackages={enabledPackages}
            pluginLoadErrors={pluginLoadErrors}
            sessionPlugins={sessionPlugins}
            executing={executing}
            commands={commands}
            resolvedSlots={resolvedSlots}
            onToggleLeftPanel={toggleLeftPanel}
            onToggleSessionList={handleToggleSessionList}
            onSwitchSession={onSwitchSession}
            onDeleteSession={onDeleteSession}
            onCloseSessionList={() => setShowSessionList(false)}
            onOpenSettings={() => setSettingsOpen(true)}
            onResetSession={onResetSession}
            onTogglePlugin={onTogglePlugin}
          />
        </ResizablePanel>

        <ResizableHandle
          withHandle
          orientation={direction}
          className={isLeftCollapsed ? "hidden" : ""}
        />

        {/* Mobile: Right panel before center */}
        {isMobile && (
          <>
            <ResizablePanel
              id="right-panel-mobile"
              panelRef={rightPanelRef}
              defaultSize="0%"
              minSize="20%"
              maxSize="80%"
              collapsible={true}
              collapsedSize="0%"
              onResize={() => setIsRightCollapsed(rightPanelRef.current?.isCollapsed() ?? false)}
              className="bg-muted/10 flex flex-col min-h-0 min-w-0"
            >
              <RightPanel
                sessionId={session.id}
                world={world}
                gameState={gameState}
                pluginData={pluginData}
                statePatches={statePatches}
                onToggleRightPanel={toggleRightPanel}
              />
            </ResizablePanel>
            <ResizableHandle
              withHandle
              orientation={direction}
              className={isRightCollapsed ? "hidden" : ""}
            />
          </>
        )}

        {/* Center Panel */}
        <ResizablePanel
          id="center-panel"
          defaultSize={isMobile ? "100%" : "55%"}
          minSize={isMobile ? "20%" : "30%"}
          className="bg-background flex flex-col min-w-0 min-h-0"
        >
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
                worldName={text(world?.name)}
                onGoWorldSelect={onBackToWorldSelect}
                onGoPrep={onResetSession}
                disabled={executing}
              />
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <div className="hidden sm:flex items-center border border-border rounded-md overflow-hidden">
                <Toggle
                  pressed={viewMode === "parsed"}
                  onPressedChange={() => setViewMode("parsed")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  <LayoutTemplate className="w-3.5 h-3.5 mr-1.5" />
                  <span className="text-xs">Parsed</span>
                </Toggle>
                <Toggle
                  pressed={viewMode === "raw"}
                  onPressedChange={() => setViewMode("raw")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  <Code className="w-3.5 h-3.5 mr-1.5" />
                  <span className="text-xs">Raw</span>
                </Toggle>
              </div>

              <div className="flex sm:hidden items-center border border-border rounded-md overflow-hidden">
                <Toggle
                  pressed={viewMode === "parsed"}
                  onPressedChange={() => setViewMode("parsed")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  aria-label="Parsed view"
                >
                  <LayoutTemplate className="w-3.5 h-3.5" />
                </Toggle>
                <Toggle
                  pressed={viewMode === "raw"}
                  onPressedChange={() => setViewMode("raw")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  aria-label="Raw view"
                >
                  <Code className="w-3.5 h-3.5" />
                </Toggle>
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-sm shrink-0"
                onClick={() => setSettingsOpen(true)}
                title={t("nav.settings")}
              >
                <KeyRound className="w-4 h-4" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-sm shrink-0"
                asChild
                title="Debug Traces"
              >
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
          <ChatMessages
            messages={messages}
            executionSteps={executionSteps}
            executionError={executionError}
            executing={executing}
            phase={phase}
            world={world}
            packages={packages}
            sessionPlugins={sessionPlugins}
            submittedBlockIds={submittedBlockIds}
            viewMode={viewMode}
            blockSelections={blockSelections}
            onSendMessage={onSendMessage}
            onSubmitBlock={onSubmitBlock}
            onSubmitInteraction={onSubmitInteraction}
            onRetryRuntime={onRetryRuntime}
            onTriggerEvent={onTriggerEvent}
            onBlockSelect={handleBlockSelect}
            onBeginAdventure={onBeginAdventure}
            messagesEndRef={messagesEndRef}
          />

          {/* Pending drafts bar — plugin-declared buttons (guide suggestions,
              draftMessage actions) stage their text here. Confirm joins them
              with newlines and sends as one player message. */}
          {pendingDrafts.length > 0 && (
            <div className="px-3 md:px-4 py-2 border-t border-border bg-primary/5 shrink-0">
              <div className="max-w-4xl mx-auto space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t("session.selectionsReady", {
                      count: pendingDrafts.length,
                      defaultValue: "{{count}} selection(s) ready",
                    })}
                  </span>
                  <Button
                    size="sm"
                    className="rounded-none gap-1.5"
                    disabled={executing}
                    onClick={handleConfirmDrafts}
                  >
                    <Check className="w-3.5 h-3.5" />
                    {t("session.confirmSelections", "Confirm")}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {pendingDrafts.map((d) => {
                    const label = String(d.values?.text ?? d.label ?? "").trim();
                    if (!label) return null;
                    return (
                      <span
                        key={d.id}
                        className="group inline-flex items-center gap-1 max-w-full rounded border border-border bg-background/80 px-2 py-0.5 text-[11px] leading-tight text-foreground"
                      >
                        <span className="truncate max-w-[260px]" title={label}>{label}</span>
                        <button
                          type="button"
                          onClick={() => removeInteractionDraft(d.id)}
                          className="text-muted-foreground/70 hover:text-destructive transition-colors"
                          aria-label="remove draft"
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

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
                      ? t(
                          "session.inputPlaceholder",
                          "Enter action or command...",
                        )
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
                  {executing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </Button>
              </div>
            )}
          </div>
        </ResizablePanel>

        {/* Desktop: Right panel */}
        {!isMobile && (
          <>
            <ResizableHandle
              withHandle
              orientation={direction}
              className={isRightCollapsed ? "hidden" : ""}
            />
            <ResizablePanel
              id="right-panel"
              panelRef={rightPanelRef}
              defaultSize="25%"
              minSize="20%"
              maxSize="50%"
              collapsible={true}
              collapsedSize="0%"
              onResize={() => setIsRightCollapsed(rightPanelRef.current?.isCollapsed() ?? false)}
              className="bg-muted/10 flex flex-col min-h-0 min-w-0"
            >
              <RightPanel
                sessionId={session.id}
                world={world}
                gameState={gameState}
                pluginData={pluginData}
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
