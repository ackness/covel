import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import {
  SlidersHorizontal,
  Database,
  Send,
  Code,
  LayoutTemplate,
  ListTree,
  Loader2,
  KeyRound,
  Check,
  Bug,
  X,
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
import { SettingsDialog } from "@/settings/SettingsDialog.js";
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
  /** Form values keyed by submitted block id — for repopulating disabled forms. */
  submittedBlockValues: Readonly<Record<string, Record<string, unknown>>>;
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
    submitBehavior?: { echoFilledNarrative?: boolean },
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
  submittedBlockValues,
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

  const [viewMode, setViewMode] = useState<"parsed" | "detailed" | "raw">("parsed");
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
  const { state: sessionState, clearInteractionDrafts, removeInteractionDraft, submitBlock } = useSession();
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
    // Stamp each source block with the player's selection so the disabled
    // re-render can show what was chosen. Generic across plugin types — any
    // draft that names a sourceBlockId participates without per-plugin code.
    const bySource = new Map<string, typeof pendingDrafts>();
    for (const draft of pendingDrafts) {
      if (!draft.sourceBlockId) continue;
      const list = bySource.get(draft.sourceBlockId) ?? [];
      list.push(draft);
      bySource.set(draft.sourceBlockId, list);
    }
    for (const [blockId, drafts] of bySource) {
      const items = drafts.map((d) => ({
        type: d.type,
        label: d.label,
        values: d.values,
        interactionId: d.interactionId,
        selectionGroup: d.selectionGroup,
      }));
      const labelSummary = drafts.map((d) => d.label).filter(Boolean).join(" / ");
      submitBlock(blockId, { _kind: "selection", _label: labelSummary, items });
    }
    onSendMessage(combined);
    clearInteractionDrafts();
    setBlockSelections({});
  }, [pendingDrafts, clearInteractionDrafts, onSendMessage, submitBlock]);

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
          <div className="h-14 px-3 border-b border-border flex justify-between items-center bg-background z-10 shrink-0 paper:h-[52px] paper:bg-card">
            <div className="flex items-center gap-2 overflow-hidden paper:gap-3">
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 rounded-sm shrink-0 paper:rounded-full paper:border paper:border-border ${!isLeftCollapsed && "bg-accent text-accent-foreground"}`}
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
              {/* Paper-only streaming pill — Variant A style */}
              <span
                className={
                  "hidden paper:inline-flex items-center gap-1 ml-2 px-2 py-[3px] rounded-full border text-[10px] font-mono uppercase tracking-[0.08em] " +
                  (executing
                    ? "border-transparent bg-[color:var(--color-primary)]/15 text-[color:var(--color-primary)]"
                    : "border-transparent bg-[oklch(62%_0.10_140_/_0.18)] text-[oklch(62%_0.10_140)]")
                }
                aria-live="polite"
              >
                <span
                  className={
                    "w-[5px] h-[5px] rounded-full bg-current " +
                    (executing ? "paper-pulse-dot" : "")
                  }
                />
                {executing ? t("session.stateStreaming") : t("session.statePlaying")}
              </span>
            </div>
            <div className="flex items-center gap-2 md:gap-4 shrink-0">
              <div className="hidden sm:flex items-center border border-border rounded-md overflow-hidden">
                <Toggle
                  pressed={viewMode === "parsed"}
                  onPressedChange={() => setViewMode("parsed")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  <LayoutTemplate className="w-3.5 h-3.5 mr-1.5" />
                  <span className="text-xs">{t("session.viewParsed")}</span>
                </Toggle>
                <Toggle
                  pressed={viewMode === "detailed"}
                  onPressedChange={() => setViewMode("detailed")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  <ListTree className="w-3.5 h-3.5 mr-1.5" />
                  <span className="text-xs">{t("session.viewDetailed")}</span>
                </Toggle>
                <Toggle
                  pressed={viewMode === "raw"}
                  onPressedChange={() => setViewMode("raw")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  <Code className="w-3.5 h-3.5 mr-1.5" />
                  <span className="text-xs">{t("session.viewRaw")}</span>
                </Toggle>
              </div>

              <div className="flex sm:hidden items-center border border-border rounded-md overflow-hidden">
                <Toggle
                  pressed={viewMode === "parsed"}
                  onPressedChange={() => setViewMode("parsed")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  aria-label={t("session.viewParsedAria")}
                >
                  <LayoutTemplate className="w-3.5 h-3.5" />
                </Toggle>
                <Toggle
                  pressed={viewMode === "detailed"}
                  onPressedChange={() => setViewMode("detailed")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  aria-label={t("session.viewDetailedAria")}
                >
                  <ListTree className="w-3.5 h-3.5" />
                </Toggle>
                <Toggle
                  pressed={viewMode === "raw"}
                  onPressedChange={() => setViewMode("raw")}
                  size="sm"
                  className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  aria-label={t("session.viewRawAria")}
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
                className="hidden md:inline-flex h-8 w-8 rounded-sm shrink-0"
                asChild
                title={t("session.debugTraces")}
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
                title={t("session.toggleContextPanel")}
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
            submittedBlockValues={submittedBlockValues}
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
            <div className="px-3 md:px-4 py-2.5 border-t border-border bg-primary/5 shrink-0">
              <div className="max-w-4xl mx-auto space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-[11px] font-medium tabular-nums leading-none">
                      {pendingDrafts.length}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {t("session.selectionsReady", { count: pendingDrafts.length })}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 rounded-sm gap-1.5 shrink-0"
                    disabled={executing}
                    onClick={handleConfirmDrafts}
                  >
                    <Check className="w-3.5 h-3.5" />
                    {t("session.confirmSelections")}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {pendingDrafts.map((d) => {
                    const label = String(d.values?.text ?? d.label ?? "").trim();
                    if (!label) return null;
                    return (
                      <span
                        key={d.id}
                        className="group inline-flex items-center gap-1 max-w-full rounded-sm border border-primary/20 bg-background pl-2 pr-0.5 py-0.5 text-[11px] leading-tight text-foreground shadow-sm"
                      >
                        <span className="truncate max-w-[260px]" title={label}>
                          {label}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeInteractionDraft(d.id)}
                          className="inline-flex items-center justify-center h-6 w-6 -my-1 rounded-sm text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
                          aria-label={t("session.removeDraft")}
                          title={t("session.removeDraft")}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Input — always fixed at bottom */}
          <div className="p-3 md:p-4 border-t border-border bg-muted/5 shrink-0 paper:bg-background paper:py-5">
            {phase === "ended" ? (
              <p className="text-center text-sm text-muted-foreground paper:font-serif paper:italic paper:text-base">
                {t("session.ended", "This session has ended.")}
              </p>
            ) : (
              <div className="max-w-4xl mx-auto paper:max-w-[42rem] space-y-1">
                <div className="flex gap-2 paper:gap-2.5">
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    aria-label={t(
                      "session.inputAriaLabel",
                      "Story input — press Enter to send",
                    )}
                    placeholder={
                      phase === "playing"
                        ? t(
                            "session.inputPlaceholder",
                            "Enter action or command...",
                          )
                        : t("session.inputPlaceholderAny", "Send a message...")
                    }
                    disabled={executing}
                    className={
                      "flex-1 min-w-0 bg-background border border-border px-3 md:px-4 py-2 md:py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary transition-all disabled:opacity-50 " +
                      "paper:rounded-md paper:bg-card paper:border-[color:var(--color-border)] paper:font-serif paper:text-[15px] paper:px-4 paper:py-3 paper:focus:ring-[color:var(--color-primary)]/40"
                    }
                  />
                  <Button
                    onClick={handleSubmit}
                    disabled={executing || !inputValue.trim()}
                    className={
                      "rounded-none px-4 md:px-6 h-auto shrink-0 " +
                      "paper:rounded-md paper:px-0 paper:w-[46px] paper:h-[46px] paper:bg-[color:var(--color-primary)] paper:text-[color:var(--color-primary-foreground)] paper:hover:opacity-90"
                    }
                    size="sm"
                  >
                    {executing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                  </Button>
                </div>
                <div className="hidden md:flex justify-end items-center gap-1 text-[10px] text-muted-foreground/70 pr-1 select-none">
                  <kbd className="px-1.5 py-0.5 font-mono border border-border/60 bg-muted/30 rounded-sm">
                    {"\u23CE"}
                  </kbd>
                  <span>{t("session.inputKbdHint", "to send")}</span>
                </div>
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
