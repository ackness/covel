import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { useSession } from "@/stores/session-store.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { resolveI18n } from "@/lib/catalog.js";
import { initDesktopBridge } from "@/lib/desktop-bridge.js";
import { WorldSelectScreen } from "@/components/session/world-select-screen.js";
import { SessionPrepScreen } from "@/components/session/session-prep-screen.js";
import { GameView } from "@/components/session/game-view.js";

interface SessionSearchParams {
  sid?: string;
}

export const Route = createFileRoute("/session")({
  component: SessionPage,
  validateSearch: (search: Record<string, unknown>): SessionSearchParams => ({
    sid: typeof search.sid === "string" ? search.sid : undefined,
  }),
});

function SessionPage() {
  const {
    state,
    selectWorld,
    startGame,
    beginAdventure,
    resumeSession,
    resumeSessionById,
    loadWorldSessions,
    deleteSession,
    sendMessage,
    submitBlock,
    submitInteraction,
    retryRuntime,
    resetSession,
    backToWorldSelect,
    updateWorldLocal,
    addWorldLocal,
    loadSessionPlugins,
    toggleSessionPlugin,
    triggerEvent,
  } = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { resolvedSlots } = useSlotConfig(state.presets, state.llmConfig);
  const { sid } = Route.useSearch();
  const navigate = useNavigate();
  const autoResumeAttempted = useRef(false);
  // Track whether a stale session existed at mount (before any user action on this page).
  // If the component mounts with a session but no sid in URL, the session is stale
  // (carried over from a previous navigation). Sessions created by startGame() on
  // this page won't be flagged because staleSessionRef is set only once at mount.
  const staleSessionRef = useRef<string | null>(
    // At mount: if session exists but URL has no sid, it's stale
    null,
  );
  useEffect(() => {
    // Run once: if we mounted with a session but no sid, mark it as stale
    if (state.session && !sid && staleSessionRef.current === null) {
      staleSessionRef.current = state.session.id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync URL with session state
  useEffect(() => {
    if (state.session && state.session.id !== sid) {
      if (!sid && state.session.id === staleSessionRef.current) {
        // Navigated to /session without sid (e.g. from homepage) while a stale
        // session is still in state — clear it so the user lands on world select.
        backToWorldSelect();
        staleSessionRef.current = null;
      } else {
        navigate({ to: "/session", search: { sid: state.session.id }, replace: true });
      }
    } else if (!state.session && sid && autoResumeAttempted.current) {
      // Session was cleared (back to world select) — remove sid from URL
      navigate({ to: "/session", search: {}, replace: true });
    }
  }, [state.session, sid, navigate, backToWorldSelect]);

  // Auto-resume from URL sid on boot
  useEffect(() => {
    if (state.booted && sid && !state.session && !autoResumeAttempted.current) {
      autoResumeAttempted.current = true;
      resumeSessionById(sid).catch(() => {
        // Session not found — clear sid from URL
        navigate({ to: "/session", search: {}, replace: true });
      });
    }
  }, [state.booted, sid, state.session, resumeSessionById, navigate]);

  // Update document.title for Electron window title sync
  useEffect(() => {
    const worldName = state.world ? resolveI18n(state.world.name) : "";
    document.title = worldName ? `Covel \u2014 ${worldName}` : "Covel";
  }, [state.world]);

  // Desktop bridge: translate Electron menu events into app actions
  const settingsOpenRef = useRef(setSettingsOpen);
  settingsOpenRef.current = setSettingsOpen;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const messagesRef = useRef(state.messages);
  messagesRef.current = state.messages;

  useEffect(() => {
    return initDesktopBridge({
      onOpenSettings: () => settingsOpenRef.current(true),
      onNewWorld: () => navigateRef.current({ to: "/session", search: {} }),
      onExportChat: () => {
        const msgs = messagesRef.current;
        if (msgs.length === 0) return;
        const text = msgs
          .map((m) => `[${m.role}] ${m.content}`)
          .join("\n\n");
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "covel-chat.txt";
        a.click();
        URL.revokeObjectURL(url);
      },
    });
  }, []);

  // Loading (boot or auto-resume in progress)
  if (!state.booted && !state.bootError) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Auto-resuming from URL — show spinner while loading
  if (state.booted && sid && !state.session && !state.world) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Boot error
  if (state.bootError) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-destructive">
        <AlertCircle className="w-5 h-5" />
        <span className="text-sm">{state.bootError}</span>
      </div>
    );
  }

  // Game view — session is active
  if (state.session) {
    return (
      <GameView
        session={state.session}
        world={state.world}
        phase={state.phase}
        messages={state.messages}
        executing={state.executing}
        executionError={state.executionError}
        packages={state.packages}
        pluginLoadErrors={state.pluginLoadErrors}
        sessionPlugins={state.sessionPlugins}
        presets={state.presets}
        commands={state.commands}
        llmConfig={state.llmConfig}
        statePatches={state.statePatches}
        gameState={state.gameState}
        pluginData={state.pluginData}
        executionSteps={state.executionSteps}
        worldSessions={state.worldSessions}
        submittedBlockIds={state.submittedBlockIds}
        submittedBlockValues={state.submittedBlockValues}
        onSendMessage={sendMessage}
        onSubmitBlock={submitBlock}
        onSubmitInteraction={submitInteraction}
        onBeginAdventure={beginAdventure}
        onRetryRuntime={retryRuntime}
        onResetSession={resetSession}
        onBackToWorldSelect={backToWorldSelect}
        onSwitchSession={resumeSession}
        onDeleteSession={deleteSession}
        onLoadWorldSessions={loadWorldSessions}
        onLoadSessionPlugins={loadSessionPlugins}
        onTogglePlugin={toggleSessionPlugin}
        onTriggerEvent={triggerEvent}
      />
    );
  }

  // Prep screen — world selected but no session yet
  if (state.world) {
    return (
      <SessionPrepScreen
        world={state.world}
        packages={state.packages}
        presets={state.presets}
        llmConfig={state.llmConfig}
        onBack={backToWorldSelect}
        onStart={startGame}
        onResume={resumeSession}
        onDeleteSession={deleteSession}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={setSettingsOpen}
      />
    );
  }

  // World selection
  return (
    <WorldSelectScreen
      worlds={state.worlds}
      packages={state.packages}
      resolvedSlots={resolvedSlots}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={setSettingsOpen}
      onSelectWorld={selectWorld}
      onWorldUpdated={updateWorldLocal}
      onWorldCreated={addWorldLocal}
    />
  );
}
