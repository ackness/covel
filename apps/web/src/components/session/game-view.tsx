import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
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
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useMediaQuery } from "@/hooks/use-media-query.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { SettingsDialog } from "@/settings/SettingsDialog.js";
import { ChatMessages } from "./chat-messages.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";
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
import { LeftPanel } from "./left-panel.js";
import { RightPanel } from "./right-panel.js";
import { onNavEvent } from "@/lib/nav-events.js";
import {
  GameViewHeader,
  type GameViewMode,
} from "./game-view/game-view-header.js";
import { MessageComposer } from "./game-view/message-composer.js";
import { PendingDraftsBar } from "./game-view/pending-drafts-bar.js";
import { useGameViewComposer } from "./game-view/use-game-view-composer.js";
import { worldVisual } from "@/lib/world-visuals.js";

// ── Extracted Panel Components (see left-panel.tsx, right-panel.tsx) ──

// ── Main Component ──────────────────────────────────────────────

interface GameViewProps {
  session: SessionRecord;
  world: WorldRecord | null;
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
  /** Submit an interactive block through framework submit-form RPC. */
  onSubmitInteraction?: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: "form" | "choice" | "confirmation",
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
  onTriggerEvent?: (
    eventType: string,
    eventData: Record<string, unknown>,
  ) => void;
}

export function GameView({
  session,
  world,
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

  const [viewMode, setViewMode] = useState<GameViewMode>("parsed");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialKey, setSettingsInitialKey] = useState<
    string | undefined
  >(undefined);

  const {
    inputValue,
    setInputValue,
    blockSelections,
    handleBlockSelect,
    pendingDrafts,
    suspensions,
    composerBlocked,
    composerDisabled,
    handleConfirmDrafts,
    handleSubmit,
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

  const handleSettingsOpenChange = (v: boolean) => {
    setSettingsOpen(v);
    if (!v) {
      setSettingsInitialKey(undefined);
      refreshSlots();
    }
  };

  // Topbar nav → in-page panel actions. The global topbar dispatches via
  // nav-events because it can't reach this component's local state directly.
  useEffect(() => {
    return onNavEvent((event) => {
      if (event === "open-plugins") {
        setSettingsInitialKey("plugin");
        setSettingsOpen(true);
        return;
      }
      if (event === "open-images" || event === "open-database") {
        // Make sure the right panel is expanded, then activate the requested
        // activity tab. Radix Tabs use pointerdown to trigger selection
        // (not click), so a plain programmatic .click() is a no-op — we
        // dispatch the matching pointerdown sequence instead.
        const panel = rightPanelRef.current;
        if (panel && panel.isCollapsed()) panel.expand();
        // The aria-label is locale-resolved (framework: t(); plugin: i18n
        // map). Both sides agree on the same translation table, so we resolve
        // the same key here to match whichever locale is active.
        const targetLabel =
          event === "open-images" ? t("nav.images") : t("session.database");
        const activate = () => {
          const tab = document.querySelector<HTMLElement>(
            `button[role="tab"][aria-label="${targetLabel}"]`,
          );
          if (!tab) return;
          // Radix Tabs trigger on the mousedown → mouseup → click sequence;
          // a plain `tab.click()` alone is a no-op because the trigger only
          // commits when it sees the pointerdown half. Replay the full
          // sequence so it matches a real interaction.
          const opts = { bubbles: true, cancelable: true, button: 0 } as const;
          tab.dispatchEvent(new MouseEvent("mousedown", opts));
          tab.dispatchEvent(new MouseEvent("mouseup", opts));
          tab.click();
        };
        // Defer two frames to give the panel time to finish expanding before
        // dispatching pointer events at the now-visible tab.
        requestAnimationFrame(() => requestAnimationFrame(activate));
      }
    });
  }, [t]);

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
        open={settingsOpen}
        onOpenChange={handleSettingsOpenChange}
        initialKey={settingsInitialKey}
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
          onResize={() =>
            setIsLeftCollapsed(leftPanelRef.current?.isCollapsed() ?? false)
          }
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
              onResize={() =>
                setIsRightCollapsed(
                  rightPanelRef.current?.isCollapsed() ?? false,
                )
              }
              className="ui-rail flex flex-col min-h-0 min-w-0"
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
          {/* Header */}
          <GameViewHeader
            t={t}
            sessionId={session.id}
            world={world}
            executing={executing}
            viewMode={viewMode}
            isLeftCollapsed={isLeftCollapsed}
            isRightCollapsed={isRightCollapsed}
            onViewModeChange={setViewMode}
            onToggleLeftPanel={toggleLeftPanel}
            onToggleRightPanel={toggleRightPanel}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenSuspensions={() => setSuspensionsOpen(true)}
            onBackToWorldSelect={onBackToWorldSelect}
            onResetSession={onResetSession}
            suspensionsCount={suspensions.length}
          />

          {/* Messages */}
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
            onKeyDown={handleKeyDown}
          />
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
              onResize={() =>
                setIsRightCollapsed(
                  rightPanelRef.current?.isCollapsed() ?? false,
                )
              }
              className="ui-rail flex flex-col min-h-0 min-w-0"
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
