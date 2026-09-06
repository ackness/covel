import { useCallback, useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { usePanelCollapse } from "./game-view/use-panel-collapse.js";
import { useNavTabActivation } from "./game-view/use-nav-tab-activation.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { SuspensionsPanel } from "./suspensions-panel.js";
import { ExecutionRecoveryNotice } from "./execution-recovery-notice.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js";
import { useDefaultLayout } from "react-resizable-panels";
import { useMediaQuery } from "@/hooks/use-media-query.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { SettingsDialog } from "@/settings/SettingsDialog.js";
import { ChatMessages } from "./chat-messages.js";
import { StageView } from "./stage/StageView.js";
import { hasSubmittedForm } from "./stage/stage-selectors.js";
import { useStageMediaPreload } from "./stage/use-stage-media-preload.js";
import { useSession } from "@/stores/session-store.js";
import type { SessionRecord } from "@/services/api.js";
import { useSettingsDialog } from "@/hooks/use-settings-dialog.js";
import { useDocumentSessionState } from "@/hooks/use-document-session-state.js";
import { LeftPanel } from "./left-panel.js";
import { RightPanel } from "./right-panel.js";
import {
  GameViewHeader,
  type GameViewMode,
} from "./game-view/game-view-header.js";
import { MessageComposer } from "./game-view/message-composer.js";
import { PendingDraftsBar } from "./game-view/pending-drafts-bar.js";
import { useGameViewComposer } from "./game-view/use-game-view-composer.js";
import { worldVisual } from "@/lib/world-visuals.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { emitNavEvent } from "@/lib/nav-events.js";

// ── Extracted Panel Components (see left-panel.tsx, right-panel.tsx) ──

// ── Main Component ──────────────────────────────────────────────

interface GameViewProps {
  /**
   * The active session, passed by the route (whose `state.session` null-check
   * is the narrowing). Everything else is read from the session store.
   */
  session: SessionRecord;
}

export function GameView({ session }: GameViewProps) {
  const {
    state,
    sendMessage: onSendMessage,
    submitBlock: onSubmitBlock,
    submitInteraction: onSubmitInteraction,
    beginAdventure: onBeginAdventure,
    retryRuntime: onRetryRuntime,
    retryInterruptedTurn,
    refreshExecutionRecovery,
    abortActiveTurn,
    resetSession: onResetSession,
    backToWorldSelect: onBackToWorldSelect,
    resumeSession: onSwitchSession,
    deleteSession: onDeleteSession,
    loadWorldSessions: onLoadWorldSessions,
    loadSessionPlugins: onLoadSessionPlugins,
    toggleSessionPlugin: onTogglePlugin,
  } = useSession();
  const {
    world,
    messages,
    executing,
    executionError,
    plugins,
    pluginLoadErrors,
    sessionPlugins,
    sessionCommands,
    presets,
    llmConfig,
    statePatches,
    executionSteps,
    worldSessions,
    submittedBlockIds,
    submittedBlockValues,
  } = state;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { resolvedSlots, refresh: refreshSlots } = useSlotConfig(
    presets,
    llmConfig,
  );

  const [viewMode, setViewMode] = useState<GameViewMode>(() =>
    world?.metadata?.defaultViewMode === "stage" ? "stage" : "parsed",
  );
  // Full-screen stage: collapse both studio rails + hide the session header so
  // the stage fills the viewport. Session-memory only (no persistence).
  const [immersive, setImmersive] = useState(false);
  // Warm the media cache with known stage art (sprites + scene backdrops)
  // during pre-game, so the opening turn paints them without a download stall.
  useStageMediaPreload(session.id, sessionPlugins);
  // Enter the stage as soon as the player submits the opening (character
  // creation) form, instead of waiting for pre-game to fully complete —
  // the backdrop shows the world hero image until the narrator's first
  // scene.set lands.
  const stageReady =
    session.phase === "playing" ||
    hasSubmittedForm(messages, submittedBlockIds);
  const settings = useSettingsDialog(refreshSlots);
  // Publishes data-turn / data-session on <html> for theme CSS to hook into.
  useDocumentSessionState();

  const handleCommandClientAction = useCallback(
    (action: {
      readonly type: string;
      readonly pluginId?: string;
      readonly panelId?: string;
    }) => {
      if (action.type === "open-debug") {
        void navigate({ to: "/debug", search: { sid: session.id } });
        return;
      }
      if (
        action.type === "open-plugin-panel" &&
        action.pluginId &&
        action.panelId
      ) {
        emitNavEvent({
          type: "open-plugin-panel",
          pluginId: action.pluginId,
          panelId: action.panelId,
        });
      }
    },
    [navigate, session.id],
  );

  const {
    inputValue,
    setInputValue,
    pendingDrafts,
    suspensions,
    composerBlocked,
    composerDisabled,
    awaitingBegin,
    handleConfirmDrafts,
    handleSubmit,
    handleAbort,
    handleKeyDown,
    commandMatches,
    commandMenuOpen,
    selectedCommandIndex,
    commandExecuting,
    commandFeedback,
    applyCommandCompletion,
    removeInteractionDraft,
    resumeSuspension,
    cancelSuspension,
  } = useGameViewComposer({
    messages,
    submittedBlockIds,
    executing,
    session,
    onSendMessage,
    commands: sessionCommands,
    onCommandClientAction: handleCommandClientAction,
  });
  const [suspensionsOpen, setSuspensionsOpen] = useState(false);
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false);
  const [mobileRightOpen, setMobileRightOpen] = useState(false);

  // Load session-scoped plugin list whenever the session changes.
  useEffect(() => {
    onLoadSessionPlugins().catch(
      ignoreError("load session plugins on session change"),
    );
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isMobile = useMediaQuery("(max-width: 767.98px)");
  const isTablet = useMediaQuery("(max-width: 1023.98px)");

  const {
    leftPanelRef,
    rightPanelRef,
    isLeftCollapsed,
    isRightCollapsed,
    handleLeftResize,
    handleRightResize,
    toggleLeftPanel,
    toggleRightPanel,
  } = usePanelCollapse();

  // Immersive stage: collapse both rails on enter, restore prior expansion on
  // exit. Only an explicit mode change drives mounted desktop panels; resize
  // transitions must not query the panel registry while rails re-register.
  const priorRailState = useRef<{ left: boolean; right: boolean } | null>(null);
  useEffect(() => {
    if (isMobile || isTablet) return;
    const left = leftPanelRef.current;
    const right = rightPanelRef.current;
    if (!left || !right) return;
    if (immersive) {
      priorRailState.current = {
        left: left.isCollapsed(),
        right: right.isCollapsed(),
      };
      left.collapse();
      right.collapse();
    } else if (priorRailState.current) {
      if (!priorRailState.current.left) left.expand();
      if (!priorRailState.current.right) right.expand();
      priorRailState.current = null;
    }
  }, [immersive, leftPanelRef, rightPanelRef]);

  // Esc leaves immersive — but only when nothing editable is focused (the stage
  // free-text composer owns Esc to cancel input) and no modal already ate it.
  useEffect(() => {
    if (!immersive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA")
      )
        return;
      setImmersive(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [immersive]);

  // Leaving stage always drops immersion so a hidden header can't strand the
  // player in a chrome-less non-stage view.
  const handleViewModeChange = (mode: GameViewMode) => {
    if (mode !== "stage") setImmersive(false);
    setViewMode(mode);
  };

  // Sentinel ref for the bottom of the message list. Auto-scroll behaviour
  // (sticky-bottom + jump-to-latest) lives in ChatMessages via useAutoScroll;
  // this ref is shared so external callers can still reach the list tail.
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Topbar nav → in-page panel actions. The global topbar dispatches via
  // nav-events because it can't reach this component's local state directly.
  useNavTabActivation({
    rightPanelRef,
    onOpenPlugins: () => settings.openWithKey("plugin"),
    onOpenContext: isMobile ? () => setMobileRightOpen(true) : undefined,
  });

  const direction = "horizontal";
  const visual = worldVisual(world);
  const leftCollapsed = isMobile ? !mobileLeftOpen : isLeftCollapsed;
  const rightCollapsed = isMobile ? !mobileRightOpen : isRightCollapsed;
  const handleToggleLeft = isMobile
    ? () => setMobileLeftOpen((open) => !open)
    : toggleLeftPanel;
  const handleToggleRight = isMobile
    ? () => setMobileRightOpen((open) => !open)
    : toggleRightPanel;

  // Remember how the player left the rails — collapsed, or dragged to a
  // particular width. Mobile and desktop keep separate layouts: the mobile
  // group stacks vertically and renders the right rail in a different slot,
  // so one layout cannot describe both. Until a layout is stored, each
  // panel's own `defaultSize` applies.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: isMobile ? "covel:game-layout:mobile" : "covel:game-layout:desktop",
    storage: localStorage,
  });

  // ── Left Panel ─────────────────────────────────────────────────

  const enabledPlugins = plugins;
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
        open={settings.open}
        onOpenChange={settings.onOpenChange}
        initialKey={settings.initialKey}
        plugins={plugins}
      />

      <Dialog open={suspensionsOpen} onOpenChange={setSuspensionsOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("session.suspensionsTitle")}</DialogTitle>
            <DialogDescription>
              {t("session.suspensionsDescription")}
            </DialogDescription>
          </DialogHeader>
          <SuspensionsPanel
            suspensions={suspensions}
            onResume={resumeSuspension}
            onCancel={cancelSuspension}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={mobileLeftOpen} onOpenChange={setMobileLeftOpen}>
        <DialogContent className="bottom-3 left-3 right-3 top-auto h-[min(88dvh,48rem)] w-auto max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">
            {t("session.config", "Studio Config")}
          </DialogTitle>
          <LeftPanel
            session={session}
            isLeftCollapsed={!mobileLeftOpen}
            showSessionList={showSessionList}
            otherSessions={otherSessions}
            enabledPlugins={enabledPlugins}
            pluginLoadErrors={pluginLoadErrors}
            sessionPlugins={sessionPlugins}
            executing={executing}
            resolvedSlots={resolvedSlots}
            onToggleLeftPanel={() => setMobileLeftOpen(false)}
            onToggleSessionList={handleToggleSessionList}
            onSwitchSession={onSwitchSession}
            onDeleteSession={onDeleteSession}
            onCloseSessionList={() => setShowSessionList(false)}
            onOpenSettings={() => settings.setOpen(true)}
            onResetSession={onResetSession}
            onTogglePlugin={onTogglePlugin}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={mobileRightOpen} onOpenChange={setMobileRightOpen}>
        <DialogContent className="bottom-3 left-3 right-3 top-auto h-[min(88dvh,48rem)] w-auto max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">
            {t("session.toggleContextPanel")}
          </DialogTitle>
          <RightPanel
            sessionId={session.id}
            world={world}
            statePatches={statePatches}
          />
        </DialogContent>
      </Dialog>

      <ResizablePanelGroup
        id="game-layout"
        orientation={direction}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="w-full h-full"
      >
        {/* Left Panel */}
        {/* Collapsed by default on every viewport: the rail holds studio
            configuration (plugin toggles, model slots), not anything the
            player acts on mid-story. The header toggle brings it back. */}
        {!isMobile && (
          <>
            <ResizablePanel
              id="left-panel"
              panelRef={leftPanelRef}
              defaultSize="0%"
              minSize="15%"
              maxSize="40%"
              collapsible={true}
              collapsedSize="0%"
              onResize={handleLeftResize}
              className="ui-rail flex flex-col min-h-0 min-w-0"
            >
              <LeftPanel
                session={session}
                isLeftCollapsed={isLeftCollapsed}
                showSessionList={showSessionList}
                otherSessions={otherSessions}
                enabledPlugins={enabledPlugins}
                pluginLoadErrors={pluginLoadErrors}
                sessionPlugins={sessionPlugins}
                executing={executing}
                resolvedSlots={resolvedSlots}
                onToggleLeftPanel={toggleLeftPanel}
                onToggleSessionList={handleToggleSessionList}
                onSwitchSession={onSwitchSession}
                onDeleteSession={onDeleteSession}
                onCloseSessionList={() => setShowSessionList(false)}
                onOpenSettings={() => settings.setOpen(true)}
                onResetSession={onResetSession}
                onTogglePlugin={onTogglePlugin}
              />
            </ResizablePanel>
            <ResizableHandle
              withHandle
              orientation={direction}
              className={isLeftCollapsed ? "hidden" : ""}
            />
          </>
        )}

        {/* Center Panel */}
        <ResizablePanel
          id="center-panel"
          defaultSize={isMobile ? "100%" : "74%"}
          minSize={isMobile ? "100%" : "30%"}
          className="relative flex flex-col min-w-0 min-h-0 overflow-hidden"
          style={
            {
              "--world-accent": visual.accent,
              background: "var(--surface-session, var(--surface-page))",
            } as React.CSSProperties
          }
        >
          <div className="ui-session-backdrop pointer-events-none absolute inset-0 overflow-hidden">
            <img
              src={visual.image}
              alt=""
              aria-hidden="true"
              width={1536}
              height={1024}
              loading="lazy"
              className="absolute inset-x-0 top-0 h-56 w-full object-cover opacity-[0.08] saturate-75"
              draggable={false}
            />
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-72"
              style={{
                background:
                  "linear-gradient(180deg, color-mix(in oklab, var(--world-accent) 12%, transparent) 0%, var(--surface-page) 92%)",
              }}
            />
          </div>
          {/* Header — hidden while the stage is immersive so it fills the
              viewport. Fades back in on exit (rails snap; chrome fades). */}
          {!(immersive && viewMode === "stage") && (
            <div className="animate-in fade-in-0 duration-200">
              <GameViewHeader
                t={t}
                sessionId={session.id}
                sessionPhase={session.phase}
                world={world}
                executing={executing}
                viewMode={viewMode}
                isLeftCollapsed={leftCollapsed}
                isRightCollapsed={rightCollapsed}
                onViewModeChange={handleViewModeChange}
                onToggleLeftPanel={handleToggleLeft}
                onToggleRightPanel={handleToggleRight}
                onOpenSettings={() => settings.setOpen(true)}
                onOpenSuspensions={() => setSuspensionsOpen(true)}
                onBackToWorldSelect={onBackToWorldSelect}
                onResetSession={onResetSession}
                suspensionsCount={suspensions.length}
              />
            </div>
          )}

          {/* Messages */}
          <ExecutionRecoveryNotice
            recovery={state.executionRecovery}
            onRetry={retryInterruptedTurn}
            onRefresh={refreshExecutionRecovery}
            onStop={abortActiveTurn}
          />
          {viewMode === "stage" && stageReady ? (
            <StageView
              key={session.id}
              session={session}
              world={world}
              messages={messages}
              executing={executing}
              executionError={executionError}
              executionSteps={executionSteps}
              plugins={plugins}
              sessionPlugins={sessionPlugins}
              submittedBlockIds={submittedBlockIds}
              submittedBlockValues={submittedBlockValues}
              onSendMessage={onSendMessage}
              onSubmitBlock={onSubmitBlock}
              onSubmitInteraction={onSubmitInteraction}
              onRetryRuntime={onRetryRuntime}
              onBeginAdventure={onBeginAdventure}
              onViewModeChange={handleViewModeChange}
              immersive={immersive}
              onToggleImmersive={() => setImmersive((v) => !v)}
              messagesEndRef={messagesEndRef}
            />
          ) : (
            <>
              <ChatMessages
                messages={messages}
                executionSteps={executionSteps}
                executionError={executionError}
                executing={executing}
                session={session}
                world={world}
                plugins={plugins}
                sessionPlugins={sessionPlugins}
                submittedBlockIds={submittedBlockIds}
                submittedBlockValues={submittedBlockValues}
                viewMode={viewMode}
                onSendMessage={onSendMessage}
                onSubmitBlock={onSubmitBlock}
                onSubmitInteraction={onSubmitInteraction}
                onRetryRuntime={onRetryRuntime}
                onBeginAdventure={onBeginAdventure}
                messagesEndRef={messagesEndRef}
              />

              <PendingDraftsBar
                t={t}
                pendingDrafts={pendingDrafts}
                executing={executing}
                onConfirmDrafts={handleConfirmDrafts}
                onRemoveDraft={removeInteractionDraft}
              />

              {/* Input — always fixed at bottom */}
              <MessageComposer
                t={t}
                session={session}
                executing={executing}
                inputValue={inputValue}
                composerBlocked={composerBlocked}
                composerDisabled={composerDisabled}
                awaitingBegin={awaitingBegin}
                onInputValueChange={setInputValue}
                onSubmit={handleSubmit}
                onAbort={handleAbort}
                onKeyDown={handleKeyDown}
                pendingDraftCount={pendingDrafts.length}
                commandMatches={commandMatches}
                commandMenuOpen={commandMenuOpen}
                selectedCommandIndex={selectedCommandIndex}
                commandExecuting={commandExecuting}
                commandFeedback={commandFeedback}
                onCommandSelect={applyCommandCompletion}
              />
            </>
          )}
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
              defaultSize={isTablet || immersive ? "0%" : "26%"}
              minSize="320px"
              maxSize="42%"
              collapsible={true}
              collapsedSize="0%"
              onResize={handleRightResize}
              className="ui-rail flex flex-col min-h-0 min-w-0"
            >
              <RightPanel
                sessionId={session.id}
                world={world}
                statePatches={statePatches}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
