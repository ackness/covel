import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { useSession } from "@/stores/session-store.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { WorldSelectScreen } from "@/components/session/world-select-screen.js";
import { SessionPrepScreen } from "@/components/session/session-prep-screen.js";
import { GameView } from "@/components/session/game-view.js";

export const Route = createFileRoute("/session")({
  component: SessionPage,
});

function SessionPage() {
  const {
    state,
    selectWorld,
    startGame,
    resumeSession,
    loadWorldSessions,
    sendMessage,
    submitBlock,
    retryRuntime,
    resetSession,
    backToWorldSelect,
    updateWorldLocal,
  } = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { resolvedSlots } = useSlotConfig(state.presets);

  // Loading
  if (!state.booted && !state.bootError) {
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
        onBack={backToWorldSelect}
        onStart={startGame}
        onResume={resumeSession}
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
    />
  );
}
