import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { useSession } from "@/stores/session-store.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
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
    resumeSession,
    resumeSessionById,
    loadWorldSessions,
    deleteSession,
    sendMessage,
    submitBlock,
    retryRuntime,
    resetSession,
    backToWorldSelect,
    updateWorldLocal,
    addWorldLocal,
  } = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { resolvedSlots } = useSlotConfig(state.presets, state.llmConfig);
  const { sid } = Route.useSearch();
  const navigate = useNavigate();
  const autoResumeAttempted = useRef(false);

  // Sync URL with session state
  useEffect(() => {
    if (state.session && state.session.id !== sid) {
      navigate({ to: "/session", search: { sid: state.session.id }, replace: true });
    } else if (!state.session && sid && autoResumeAttempted.current) {
      // Session was cleared (back to world select) — remove sid from URL
      navigate({ to: "/session", search: {}, replace: true });
    }
  }, [state.session, sid, navigate]);

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
        presets={state.presets}
        commands={state.commands}
        llmConfig={state.llmConfig}
        statePatches={state.statePatches}
        gameState={state.gameState}
        executionSteps={state.executionSteps}
        worldSessions={state.worldSessions}
        submittedBlockIds={state.submittedBlockIds}
        onSendMessage={sendMessage}
        onSubmitBlock={submitBlock}
        onRetryRuntime={retryRuntime}
        onResetSession={resetSession}
        onBackToWorldSelect={backToWorldSelect}
        onSwitchSession={resumeSession}
        onDeleteSession={deleteSession}
        onLoadWorldSessions={loadWorldSessions}
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
