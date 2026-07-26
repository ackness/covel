import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
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
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js";
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
    packages,
    pluginLoadErrors,
    sessionPlugins,
    presets,
    llmConfig,
    statePatches,
    executionSteps,
    worldSessions,
    submittedBlockIds,
    submittedBlockValues,
  } = state;
  const { t } = useTranslation();
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
    session.turnCount >= 1 || hasSubmittedForm(messages, submittedBlockIds);
  const settings = useSettingsDialog(refreshSlots);
  // Publishes data-turn / data-session on <html> for theme CSS to hook into.
  useDocumentSessionState();

  const {
    inputValue,
    setInputValue,
    pendingDrafts,
    suspensions,
    composerBlocked,
    composerDisabled,
    handleConfirmDrafts,
    handleSubmit,
    handleAbort,
    handleKeyDown,
    removeInteractionDraft,
    resumeSuspension,
    cancelSuspension,
  } = useGameViewComposer({
    messages,
    submittedBlockIds,
    executing,
    onSendMessage,
  });
  const [suspensionsOpen, setSuspensionsOpen] = useState(false);

  // Load session-scoped plugin list whenever the session changes.
  useEffect(() => {
    onLoadSessionPlugins().catch(
      ignoreError("load session plugins on session change"),
    );
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isMobile = useMediaQuery("(max-width: 768px)");
  const isTablet = useMediaQuery("(max-width: 1024px)");

  const {
    leftPanelRef,
    rightPanelRef,
    isLeftCollapsed,
    isRightCollapsed,
    handleLeftResize,
    handleRightResize,
    toggleLeftPanel,
    toggleRightPanel,
  } = usePanelCollapse(isMobile, isTablet);

  // Immersive stage: collapse both rails on enter, restore prior expansion on
  // exit. On mobile/tablet the rails are already collapsed by usePanelCollapse,
  // so we only drive the imperative panels on wide viewports.
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
  }, [immersive, isMobile, isTablet, leftPanelRef, rightPanelRef]);

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
  });

  const direction = isMobile ? "vertical" : "horizontal";
  const visual = worldVisual(world);

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
        open={settings.open}
        onOpenChange={settings.onOpenChange}
        initialKey={settings.initialKey}
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

      <ResizablePanelGroup
        id="game-layout"
        orientation={direction}
        className="w-full h-full"
      >
        {/* Left Panel */}
        <ResizablePanel
          id="left-panel"
          panelRef={leftPanelRef}
          defaultSize={isMobile ? "0%" : "20%"}
          minSize="15%"
          maxSize={isMobile ? "80%" : "40%"}
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
            enabledPackages={enabledPackages}
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
              onResize={handleRightResize}
              className="ui-rail flex flex-col min-h-0 min-w-0"
            >
              <RightPanel
                sessionId={session.id}
                world={world}
                statePatches={statePatches}
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
          className="relative flex flex-col min-w-0 min-h-0 overflow-hidden"
          style={
            {
              "--world-accent": visual.accent,
              background: "var(--surface-page)",
            } as React.CSSProperties
          }
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
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
                world={world}
                executing={executing}
                viewMode={viewMode}
                isLeftCollapsed={isLeftCollapsed}
                isRightCollapsed={isRightCollapsed}
                onViewModeChange={handleViewModeChange}
                onToggleLeftPanel={toggleLeftPanel}
                onToggleRightPanel={toggleRightPanel}
                onOpenSettings={() => settings.setOpen(true)}
                onOpenSuspensions={() => setSuspensionsOpen(true)}
                onBackToWorldSelect={onBackToWorldSelect}
                onResetSession={onResetSession}
                suspensionsCount={suspensions.length}
              />
            </div>
          )}

          {/* Messages */}
          {viewMode === "stage" && stageReady ? (
            <StageView
              session={session}
              world={world}
              messages={messages}
              executing={executing}
              executionError={executionError}
              executionSteps={executionSteps}
              packages={packages}
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
                packages={packages}
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
                onInputValueChange={setInputValue}
                onSubmit={handleSubmit}
                onAbort={handleAbort}
                onKeyDown={handleKeyDown}
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
              defaultSize="25%"
              minSize="20%"
              maxSize="50%"
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
