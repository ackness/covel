import { usePluginThemes } from "./game-view/use-plugin-themes.js";
import { SessionThemeSettings } from "./session-theme-settings.js";
import { SessionRecoveryControls } from "./session-recovery-controls.js";
import { usePluginThemePart } from "@/theme-system/use-plugin-theme.js";
import { AutoAdvanceControl } from "./auto-advance-control.js";
import { parsePluginViewMode } from "@covel/shared";
import { usePluginViews } from "./game-view/use-plugin-views.js";
import { PluginViewHost } from "./plugin-view-host.js";
import {
  SandboxSurfaceHost,
  SandboxSurfaceControls,
} from "./sandbox-surface-host.js";
import type { PluginViewEntry } from "./game-view/use-plugin-views.js";
import {
  requestedViewGrants,
  usePluginViewConsent,
} from "./plugin-view-consent.js";
import { Button } from "@/components/ui/button.js";
import { emitToast } from "@/lib/toast-channel.js";
import { SessionDimensionsPanel } from "./session-dimensions-panel.js";
import { useCallback, useMemo, useState, useRef, useEffect } from "react";
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
import { UnsavedNarratives } from "./unsaved-narratives.js";
import { ExecutionRecoveryNotice } from "./execution-recovery-notice.js";
import { MemoryIndexNotice } from "./memory-index-notice.js";
import { SetupProgressNotice, setupProgress } from "./setup-progress-notice.js";
import { WorldDataNotices } from "./world-data-notices.js";
import { SessionPluginNotices } from "./session-plugin-notices.js";
import { DimensionProviderNotice } from "./dimension-provider-notice.js";
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
import { useRightPanelState } from "./right-panel-state.js";
import { RightPanel } from "./right-panel.js";
import {
  GameViewHeader,
  type GameViewMode,
} from "./game-view/game-view-header.js";
import { MessageComposer } from "./game-view/message-composer.js";
import { PendingDraftsBar } from "./game-view/pending-drafts-bar.js";
import { useGameViewComposer } from "./game-view/use-game-view-composer.js";
import { useGameViewMode } from "./game-view/use-game-view-mode.js";
import { worldVisual } from "@/lib/world-visuals.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { emitNavEvent, type SessionPanel } from "@/lib/nav-events.js";
import {
  executionRecoveryNoticeVisible,
  latestExecutionPresentation,
  recoveryNoticeTurnId,
} from "./execution-presentation.js";
import { SessionBackdrop } from "./session-backdrop.js";
import { SessionMusic } from "./session-music.js";
import {
  SessionModelUsesContext,
  sessionModelUses,
} from "./provider-failure-notice.js";
import { SceneHud } from "./scene-hud.js";
import { useThemeLayout } from "@/theme-system/use-theme-layout.js";

// ── Extracted Panel Components (see left-panel.tsx, right-panel.tsx) ──

// ── Main Component ──────────────────────────────────────────────

interface GameViewProps {
  /**
   * The active session, passed by the route (whose `state.session` null-check
   * is the narrowing). Everything else is read from the session store.
   */
  session: SessionRecord;
  requestedPanel?: SessionPanel;
  onPanelHandled?: () => void;
}

export function GameView({
  session,
  requestedPanel,
  onPanelHandled,
}: GameViewProps) {
  const {
    state,
    sendMessage: onSendMessage,
    submitBlock: onSubmitBlock,
    submitInteraction: onSubmitInteraction,
    beginAdventure: onBeginAdventure,
    retryRuntime: onRetryRuntime,
    retryInterruptedTurn,
    resolveSetupRuntime,
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
    sessionCommandsLoaded,
    unavailableSessionPlugins,
    worldDataNotices,
    presets,
    llmConfig,
    executionSteps,
    worldSessions,
    submittedBlockIds,
    submittedBlockValues,
  } = state;
  const { t, i18n } = useTranslation();
  const recoveryNoticeVisible = executionRecoveryNoticeVisible(
    state.executionRecovery,
  );
  const recoveryTurnId = recoveryNoticeTurnId(
    state.executionRecovery,
    executionSteps,
  );
  const executionState = useMemo(
    () =>
      latestExecutionPresentation({
        executing,
        executionSteps,
        messages,
        executionRecovery: state.executionRecovery,
      }),
    [executing, executionSteps, messages, state.executionRecovery?.status],
  );
  const navigate = useNavigate();
  const { resolvedSlots, refresh: refreshSlots } = useSlotConfig(
    presets,
    llmConfig,
  );

  const pluginThemes = usePluginThemes(
    session.id,
    sessionPlugins,
    i18n.language,
  );
  const decorativePart = usePluginThemePart(session.id, "surface");
  const pluginViews = usePluginViews(session.id, sessionPlugins, i18n.language);
  const allViews = useMemo(
    () => [...pluginViews.views, ...(pluginViews.composers ?? [])],
    [pluginViews.views, pluginViews.composers],
  );
  const viewConsent = usePluginViewConsent(allViews, session.id);
  const [viewMode, setViewMode, viewInfo] = useGameViewMode(
    world?.id === session.worldId ? world : null,
    pluginViews,
    viewConsent.isAllowed,
    session.id,
  );
  const activePluginView = pluginViews.views.find(
    (entry) => entry.mode === viewMode,
  );
  const [composerSelection, setComposerSelection] = useState<{
    sessionId: string;
    mode: string;
  } | null>(null);
  const composerMode =
    composerSelection?.sessionId === session.id ? composerSelection.mode : "";
  const selectedComposer = pluginViews.composers?.find(
    (entry) => entry.mode === composerMode,
  );
  const activeComposer =
    selectedComposer && viewConsent.isAllowed(selectedComposer)
      ? selectedComposer
      : undefined;
  const consentEntry =
    viewInfo.consentView ??
    (selectedComposer && !activeComposer ? selectedComposer : undefined);
  const consentVisit = useRef(0);
  const [failures, setFailures] = useState<{
    sessionId: string;
    main?: PluginViewEntry;
    composer?: PluginViewEntry;
  }>({ sessionId: session.id });
  const selectionOwner = useRef<{
    sessionId: string;
    main?: string;
    composer?: string;
  }>({
    sessionId: session.id,
    main: viewMode,
    composer: activeComposer?.mode,
  });
  selectionOwner.current = {
    sessionId: session.id,
    main: viewMode,
    composer: activeComposer?.mode,
  };
  const currentRegion = (
    entry: PluginViewEntry,
    region: "main" | "composer",
  ) => {
    const allowed = viewConsent.isCurrent(entry);
    return () =>
      selectionOwner.current.sessionId === session.id &&
      selectionOwner.current[region] === entry.mode &&
      allowed();
  };
  const chooseComposer = (mode: string) => {
    consentVisit.current++;
    retryOwner.current.composer++;
    if (mode && !pluginViews.composers?.some((entry) => entry.mode === mode))
      return;
    setComposerSelection(mode ? { sessionId: session.id, mode } : null);
    setFailures((previous) => ({ ...previous, composer: undefined }));
  };
  const declineConsent = () => {
    consentVisit.current++;
    if (consentEntry?.spec.surface === "composer") chooseComposer("");
    else setViewMode(viewInfo.hostDefault);
  };
  // Once an active region loses its declaration or permission, require a new explicit choice.
  const lastActive = useRef<{
    sessionId?: string;
    main?: PluginViewEntry;
    composer?: PluginViewEntry;
  }>({});
  useEffect(() => {
    const previous = lastActive.current;
    // A request failure is not evidence that a provider disappeared. Cached
    // declarations remain usable only within their session and while authorized.
    const retired = (entry: PluginViewEntry) =>
      pluginViews.status === "ready" ||
      !sessionPlugins.some(
        (plugin) => plugin.id === entry.pluginId && plugin.active,
      ) ||
      allViews.some(
        (current) =>
          current.mode === entry.mode && !viewConsent.isAllowed(current),
      );
    if (
      previous.sessionId === session.id &&
      previous.main &&
      !activePluginView &&
      retired(previous.main) &&
      viewInfo.requestedMode === previous.main.mode
    )
      setViewMode(viewInfo.hostDefault);
    if (
      previous.sessionId === session.id &&
      previous.composer &&
      !activeComposer &&
      retired(previous.composer) &&
      composerMode === previous.composer.mode
    )
      setComposerSelection(null);
    lastActive.current = {
      sessionId: session.id,
      main: activePluginView,
      composer: activeComposer,
    };
  }, [
    activePluginView,
    activeComposer,
    composerMode,
    setViewMode,
    viewInfo.hostDefault,
    viewInfo.requestedMode,
    session.id,
    sessionPlugins,
    pluginViews.status,
    allViews,
    viewConsent.isAllowed,
  ]);
  const consentDialog = useRef(consentEntry);
  consentDialog.current = consentEntry;
  const [savingViewConsent, setSavingViewConsent] = useState(false);
  // Full-screen stage: collapse both studio rails + hide the session header so
  // the stage fills the viewport. Session-memory only (no persistence).
  const [immersive, setImmersive] = useState(false);
  const [replayStageStory, setReplayStageStory] = useState(false);
  // Warm the media cache with known stage art (sprites + scene backdrops)
  // during pre-game, so the opening turn paints them without a download stall.
  useStageMediaPreload(session.id);
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
      if (action.type === "open-plugin-diagnostics") {
        void navigate({
          to: "/debug",
          search: {
            sid: session.id,
            view: "plugins",
            pluginId: action.pluginId,
          },
        });
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
    composerModes,
    canSubmit,
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
    commandsLoaded: sessionCommandsLoaded,
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
    consentVisit.current++;
    retryOwner.current.main++;
    setFailures((previous) => ({ ...previous, main: undefined }));
    if (mode !== "stage") setImmersive(false);
    setReplayStageStory(mode === "stage");
    setViewMode(mode);
  };

  // Sentinel ref for the bottom of the message list. Auto-scroll behaviour
  // (sticky-bottom + jump-to-latest) lives in ChatMessages via useAutoScroll;
  // this ref is shared so external callers can still reach the list tail.
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Topbar nav → in-page panel actions. The global topbar dispatches via
  // nav-events because it can't reach this component's local state directly.
  const panelRequest = useNavTabActivation({
    rightPanelRef,
    onOpenPlugins: () => settings.openWithKey("plugin"),
    onOpenContext: isMobile ? () => setMobileRightOpen(true) : undefined,
    requestedPanel,
    onPanelHandled,
  });
  const rightPanelState = useRightPanelState(session.id, panelRequest);

  const direction = "horizontal";
  const visual = worldVisual(world);
  const layout = useThemeLayout();
  const stageActive = viewMode === "stage" && stageReady;
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

  const renderMessages = (content?: "story" | "pending") => (
    <ChatMessages
      content={content}
      recoveryTurnId={recoveryTurnId}
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
      viewMode={
        content
          ? "parsed"
          : viewMode === "detailed" ||
              viewMode === "raw" ||
              viewMode === "stage"
            ? viewMode
            : "parsed"
      }
      onSendMessage={onSendMessage}
      onSubmitBlock={onSubmitBlock}
      onSubmitInteraction={onSubmitInteraction}
      onRetryRuntime={onRetryRuntime}
      onBeginAdventure={onBeginAdventure}
      messagesEndRef={messagesEndRef}
    />
  );

  const failRegion = (entry: PluginViewEntry, region: "main" | "composer") => {
    selectionOwner.current[region] = undefined;
    if (region === "main") setViewMode(viewInfo.hostDefault);
    else setComposerSelection(null);
    setFailures((previous) => ({
      ...(previous.sessionId === session.id ? previous : {}),
      sessionId: session.id,
      [region]: entry,
    }));
  };
  const retryOwner = useRef({ main: 0, composer: 0 });
  const visitOwner = useRef({ id: session.id });
  if (visitOwner.current.id !== session.id)
    visitOwner.current = { id: session.id };
  const retryRegion = (entry: PluginViewEntry, region: "main" | "composer") => {
    const attempt = ++retryOwner.current[region];
    const visit = visitOwner.current;
    void Promise.resolve(pluginViews.reload())
      .then(() => {
        if (
          visitOwner.current !== visit ||
          retryOwner.current[region] !== attempt
        )
          return;
        if (region === "main") setViewMode(entry.mode);
        else setComposerSelection({ sessionId: visit.id, mode: entry.mode });
        setFailures((previous) => ({ ...previous, [region]: undefined }));
      })
      .catch(() => emitToast("error", t("session.pageLoadFailed")));
  };
  const composerRegion = activeComposer ? (
    <SandboxSurfaceHost
      key={JSON.stringify([session.id, activeComposer.mode])}
      entry={activeComposer}
      sessionId={session.id}
      sessionBridgeAllowed
      isCurrent={currentRegion(activeComposer, "composer")}
      onFallback={(reason) => {
        if (reason) failRegion(activeComposer, "composer");
        else chooseComposer("");
      }}
      onRetry={() => retryRegion(activeComposer, "composer")}
      onRevoke={(capability) => {
        chooseComposer("");
        void viewConsent
          .revoke(activeComposer, capability)
          .catch(() => emitToast("error", t("settings.saveFailed")));
      }}
    />
  ) : null;
  const hostComposer = (
    <MessageComposer
      recoveryNoticeVisible={recoveryNoticeVisible}
      executionState={executionState}
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
      composerModes={composerModes}
      canSubmit={canSubmit}
    />
  );
  const renderComposer = () => (
    <>
      <PendingDraftsBar
        t={t}
        pendingDrafts={pendingDrafts}
        executing={executing}
        onConfirmDrafts={handleConfirmDrafts}
        onRemoveDraft={removeInteractionDraft}
      />

      <SessionDimensionsPanel recoveryOnly />

      {/* Input — always fixed at bottom */}
      {!activeComposer && hostComposer}
    </>
  );

  const returnToDefault = () => {
    selectionOwner.current.main = undefined;
    selectionOwner.current.composer = undefined;
    handleViewModeChange(viewInfo.hostDefault);
    chooseComposer("");
    setImmersive(false);
    setFailures({ sessionId: session.id });
  };
  const surfaceNotices =
    failures.sessionId === session.id
      ? (["main", "composer"] as const).flatMap((region) => {
          const entry = failures[region];
          return entry
            ? [
                {
                  region,
                  label: entry.label,
                  onRetry: () => retryRegion(entry, region),
                  onRevoke: () => {
                    void viewConsent
                      .revoke(entry)
                      .catch(() =>
                        emitToast("error", t("settings.saveFailed")),
                      );
                  },
                },
              ]
            : [];
        })
      : [];
  const content = (
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
            panelState={rightPanelState}
            sessionId={session.id}
            world={world}
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
          className="ui-session-center relative flex flex-col min-w-0 min-h-0 overflow-hidden"
          style={
            {
              "--world-accent": visual.accent,
              background: "var(--surface-session, var(--surface-page))",
            } as React.CSSProperties
          }
        >
          <SessionMusic sessionId={session.id} />
          {/* The stage view paints its own backdrop layer. */}
          {!stageActive && (
            <SessionBackdrop
              mode={layout.backdrop}
              sessionId={session.id}
              world={world}
              visual={visual}
            />
          )}
          {!stageActive && layout.backdrop === "scene" && (
            <SceneHud sessionId={session.id} />
          )}
          {/* Header — hidden while the stage is immersive so it fills the
              viewport. Fades back in on exit (rails snap; chrome fades). */}
          {!(immersive && viewMode === "stage") && (
            // Host menus must open above both surface controls and notices.
            <div
              data-testid="session-header"
              className="relative animate-in fade-in-0 duration-200"
              style={{ zIndex: 40 }}
            >
              <GameViewHeader
                themeSettings={
                  <SessionThemeSettings
                    key={pluginThemes.source?.scope ?? session.id}
                    source={pluginThemes.source}
                    onReload={pluginThemes.reload}
                  />
                }
                recoveryNoticeVisible={recoveryNoticeVisible}
                executionState={executionState}
                t={t}
                sessionId={session.id}
                sessionPhase={session.phase}
                locale={session.locale}
                turnCount={session.completedPlayerTurns}
                world={world}
                executing={executing}
                viewMode={viewMode}
                pluginViews={pluginViews.views}
                hostDefaultMode={viewInfo.hostDefault}
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

          {(allViews.length > 0 || surfaceNotices.length > 0) && (
            <SandboxSurfaceControls
              mainLabel={activePluginView?.label ?? t("session.surfaceDefault")}
              composers={pluginViews.composers ?? []}
              composerMode={composerMode}
              onComposerChange={chooseComposer}
              onReturn={returnToDefault}
              onStop={() => void abortActiveTurn()}
              onRecovery={() => {
                handleViewModeChange("parsed");
                if (suspensions.length > 0) setSuspensionsOpen(true);
              }}
              executing={
                executing ||
                (!!state.advance && state.advance.phase !== "stopped")
              }
              notices={surfaceNotices}
            />
          )}
          <SessionRecoveryControls theme={pluginThemes.source} />
          <AutoAdvanceControl key={`auto-advance:${session.id}`} />

          {sessionPlugins.some((plugin) => plugin.approvalRequired) && (
            <div
              role="status"
              className="relative z-10 flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs"
            >
              <span>{t("plugin.approval.required")}</span>
              {sessionPlugins
                .filter((plugin) => plugin.approvalRequired)
                .map((plugin) => (
                  <button
                    key={plugin.id}
                    type="button"
                    className="underline"
                    disabled={executing}
                    onClick={() => void onTogglePlugin(plugin.id, true)}
                  >
                    {t("plugin.approval.review", {
                      plugin:
                        resolveDisplayText(plugin.displayName) || plugin.id,
                    })}
                  </button>
                ))}
            </div>
          )}

          <SessionPluginNotices
            plugins={sessionPlugins}
            unavailable={unavailableSessionPlugins}
            offTitle={t("plugin.unavailable")}
            variant="bar"
            busy={executing}
            onTurnOn={(pluginId) => void onTogglePlugin(pluginId, true)}
          />

          <WorldDataNotices notices={worldDataNotices} />

          <DimensionProviderNotice
            providerPluginId={state.gameState.dimensionProviderPluginId}
            plugins={sessionPlugins}
          />

          {/* Messages */}
          {stageActive && <SessionDimensionsPanel recoveryOnly />}
          <UnsavedNarratives
            messages={state.unsavedNarratives ?? []}
            recovery={state.executionRecovery}
            executing={state.executing}
            onRetry={retryInterruptedTurn}
          />
          <ExecutionRecoveryNotice
            recovery={state.executionRecovery}
            steps={executionSteps}
            onOpenSettings={settings.openWithKey}
            onRetry={retryInterruptedTurn}
            onRefresh={refreshExecutionRecovery}
            onStop={abortActiveTurn}
          />
          <MemoryIndexNotice
            sessionId={session.id}
            refreshKey={settings.open}
          />
          <SetupProgressNotice
            progress={setupProgress({
              session,
              messages,
              submittedBlockIds,
              executing,
              recovery: state.executionRecovery,
              steps: executionSteps,
            })}
            onRearm={(runtimeId) =>
              resolveSetupRuntime(session.id, runtimeId, "retry")
            }
            onRun={onBeginAdventure}
            onOpenSettings={settings.openWithKey}
          />
          {consentEntry && (
            <Dialog
              open={viewConsent.ready(consentEntry)}
              onOpenChange={(open) => {
                if (!open) declineConsent();
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {t("session.viewConsentTitle", {
                      label: consentEntry.label,
                    })}
                  </DialogTitle>
                  <DialogDescription>
                    {t("session.viewConsentDescription", {
                      plugin: consentEntry.pluginName,
                    })}
                  </DialogDescription>
                </DialogHeader>
                <ul className="list-disc pl-5">
                  {requestedViewGrants(consentEntry).map((capability) => (
                    <li key={capability}>
                      {t(`session.viewCapability.${capability}`)}
                    </li>
                  ))}
                </ul>
                <div
                  data-covel-host-controls=""
                  className="flex flex-wrap justify-end gap-2"
                >
                  <Button variant="outline" onClick={returnToDefault}>
                    {t("session.surfaceReturn")}
                  </Button>
                  {executing && (
                    <Button
                      variant="outline"
                      onClick={() => void abortActiveTurn()}
                    >
                      {t("session.surfaceStop")}
                    </Button>
                  )}
                  <Button variant="outline" onClick={declineConsent}>
                    {t("session.viewConsentDecline")}
                  </Button>
                  <Button
                    disabled={savingViewConsent}
                    onClick={() => {
                      setSavingViewConsent(true);
                      const visit = consentVisit.current;
                      void viewConsent
                        .grant(
                          consentEntry,
                          () =>
                            consentVisit.current === visit &&
                            consentDialog.current === consentEntry,
                        )
                        .catch(() =>
                          emitToast("error", t("settings.saveFailed")),
                        )
                        .finally(() => setSavingViewConsent(false));
                    }}
                  >
                    {t("session.viewConsentAllow")}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
          {activePluginView && parsePluginViewMode(viewMode) ? (
            <div className="relative z-1 flex min-h-0 flex-1 flex-col overflow-hidden">
              <PluginViewHost
                onRetry={() => retryRegion(activePluginView, "main")}
                key={JSON.stringify([session.id, activePluginView.mode])}
                entry={activePluginView}
                sessionId={session.id}
                executing={executing}
                onStop={handleAbort}
                awaitingBegin={awaitingBegin}
                onBegin={onBeginAdventure}
                liveSession={{
                  sessionId: session.id,
                  renderMessages: (content) => (
                    <div
                      className={
                        content === "story"
                          ? "flex h-[60dvh] min-h-48 flex-col"
                          : "flex max-h-[50dvh] min-h-24 flex-col"
                      }
                    >
                      {renderMessages(content)}
                    </div>
                  ),
                  renderComposer: () =>
                    activeComposer ? null : renderComposer(),
                }}
                sessionBridgeAllowed={viewConsent.isAllowed(activePluginView)}
                isCurrent={currentRegion(activePluginView, "main")}
                onFallback={(reason) => {
                  if (reason) failRegion(activePluginView, "main");
                  else handleViewModeChange(viewInfo.hostDefault);
                }}
                onRevoke={(capability) => {
                  handleViewModeChange(viewInfo.hostDefault);
                  void viewConsent
                    .revoke(activePluginView, capability)
                    .catch(() => emitToast("error", t("settings.saveFailed")));
                }}
              />
              {!activeComposer &&
                activePluginView.spec.surface === "main" &&
                hostComposer}
            </div>
          ) : stageActive ? (
            <StageView
              replayStoryOnEnter={replayStageStory}
              composerReplaced={Boolean(activeComposer)}
              advancing={!!state.advance && state.advance.phase !== "stopped"}
              recoveryTurnId={recoveryTurnId}
              composerDraft={{ value: inputValue, onChange: setInputValue }}
              composerModes={composerModes}
              panelState={rightPanelState}
              key={session.id}
              session={session}
              world={world}
              messages={messages}
              executing={executing}
              restoring={Boolean(
                state.executionRecovery?.hydrating ||
                state.executionRecovery?.checking,
              )}
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
            <div className="ui-story-surface relative z-1 flex min-h-0 flex-1 flex-col">
              <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
                <div
                  aria-hidden="true"
                  className="ui-session-theme-plane"
                  {...decorativePart}
                />
                {renderMessages()}
              </div>

              {renderComposer()}
            </div>
          )}
          {composerRegion}
        </ResizablePanel>

        {/* Desktop: Right panel */}
        {!isMobile && (
          <>
            <ResizableHandle
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
                panelState={rightPanelState}
                sessionId={session.id}
                world={world}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
  return (
    <SessionModelUsesContext.Provider
      value={sessionModelUses(
        sessionPlugins,
        resolvedSlots,
        session.runtimeModelOverrides,
      )}
    >
      {content}
    </SessionModelUsesContext.Provider>
  );
}
