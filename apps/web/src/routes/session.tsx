import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Loader2, AlertCircle } from "lucide-react";
import { useSession } from "@/stores/session-store.js";
import { getDataService } from "@/services/data-service.js";
import { mergeChatExportMessages } from "@/lib/chat-export.js";
import { getStreamingText } from "@/stores/streaming-text-store.js";
import { emitToast } from "@/lib/toast-channel.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { useSessionNavigation } from "@/hooks/use-session-navigation.js";
import type { SessionPanel } from "@/lib/nav-events.js";
import { useSettingsDialog } from "@/hooks/use-settings-dialog.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import { initDesktopBridge } from "@/lib/desktop-bridge.js";
import { WorldSelectScreen } from "@/components/session/world-select-screen.js";
import { SessionPrepScreen } from "@/components/session/session-prep-screen.js";
import { OnboardingWizard } from "@/components/onboarding-wizard.js";
import { isOnboarded } from "@/components/onboarding-wizard/persistence.js";
import { ExecutionRecoveryNotice } from "@/components/session/execution-recovery-notice.js";

// Lazy-load the in-game surface (chat + stage + json-render panels + plugin
// UI) — the single heaviest component tree in the app, but only reachable once
// a session is active. Keeping it out of the main chunk trims first paint for
// the marketing home / world-select / prep screens, which never touch it
// (bundle budget). Split alongside the already-lazy /debug route.
const GameView = lazy(() =>
  import("@/components/session/game-view.js").then((m) => ({
    default: m.GameView,
  })),
);

interface SessionSearchParams {
  sid?: string;
  panel?: SessionPanel;
}

export const Route = createFileRoute("/session")({
  component: SessionPage,
  validateSearch: (search: Record<string, unknown>): SessionSearchParams => ({
    sid: typeof search.sid === "string" && search.sid ? search.sid : undefined,
    panel:
      search.panel === "plugins" || search.panel === "images"
        ? search.panel
        : undefined,
  }),
});

function SessionPage() {
  const { t } = useTranslation();
  const {
    state,
    boot,
    selectWorld,
    startGame,
    resumeSession,
    resumeSessionById,
    retryInterruptedTurn,
    refreshExecutionRecovery,
    abortActiveTurn,
    deleteSession,
    backToWorldSelect,
    updateWorldLocal,
    addWorldLocal,
    removeWorldLocal,
  } = useSession();
  const { resolvedSlots, refresh: refreshSlots } = useSlotConfig(
    state.presets,
    state.llmConfig,
  );
  const settings = useSettingsDialog(refreshSlots);
  const [onboardingOpen, setOnboardingOpen] = useState(() => !isOnboarded());
  const { sid, panel } = Route.useSearch();
  const navigate = useNavigate();
  const replaceSessionUrl = useCallback(
    (id?: string) => {
      void navigate({
        to: "/session",
        search: id ? { sid: id, panel } : {},
        replace: true,
      });
    },
    [navigate, panel],
  );
  const navigation = useSessionNavigation({
    booted: state.booted,
    sid,
    sessionId: state.session?.id,
    hasRecovery: !!state.executionRecovery,
    resumeSessionById,
    backToWorldSelect,
    replaceSessionUrl,
  });
  const handlePanelHandled = useCallback(() => {
    void navigate({ to: "/session", search: { sid }, replace: true });
  }, [navigate, sid]);

  // Update document.title for Electron window title sync
  useEffect(() => {
    const worldName = state.world ? resolveI18n(state.world.name) : "";
    document.title = worldName ? `Covel \u2014 ${worldName}` : "Covel";
  }, [state.world]);

  // Desktop bridge: translate Electron menu events into app actions
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const messagesRef = useRef(state.messages);
  messagesRef.current = state.messages;
  const sessionIdRef = useRef(state.session?.id);
  sessionIdRef.current = state.session?.id;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    return initDesktopBridge({
      onOpenSettings: () => settings.setOpen(true),
      onNewWorld: () => navigateRef.current({ to: "/session", search: {} }),
      onExportChat: () => {
        const tt = tRef.current;
        const sid = sessionIdRef.current;
        void (async () => {
          // 导出以持久化全量历史为基底（窗口化后 state.messages 只含最近一窗 + 已上滚
          // 加载的部分，可能不完整），再按 id 并入内存里尚未落盘的消息（如正在流式生成的
          // 占位）。这样既不丢早期历史，也不丢屏幕上正在生成、尚未落盘的内容。拉取失败则
          // 回退到内存已加载部分。
          const inMemory = messagesRef.current;
          let msgs: ReadonlyArray<{
            id: string;
            role: string;
            content: string;
          }> = inMemory;
          if (sid) {
            try {
              const full = await getDataService().listMessages(sid);
              if (full.length > 0) {
                msgs = mergeChatExportMessages(full, inMemory);
              }
            } catch {
              // 回退到内存中已加载的消息。
            }
          }
          if (msgs.length === 0) {
            emitToast(
              "info",
              tt("session.exportEmpty", "No messages to export yet"),
            );
            return;
          }
          try {
            const text = msgs
              // A message still streaming has an empty `content` (live text
              // lives in the external store); resolve it so a mid-stream export
              // keeps the partial assistant text instead of a blank row.
              .map(
                (m) =>
                  `[${m.role}] ${m.content || getStreamingText(m.id) || ""}`,
              )
              .join("\n\n");
            const blob = new Blob([text], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "covel-chat.txt";
            a.click();
            URL.revokeObjectURL(url);
            emitToast("success", tt("session.exportSuccess", "Chat exported"));
          } catch (err) {
            emitToast(
              "error",
              tt("session.exportFailed", "Failed to export chat"),
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
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

  if (navigation.error && !state.executionRecovery) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div
          role="alert"
          className="max-w-lg space-y-4 border border-border p-6"
        >
          <p className="text-sm text-destructive">{navigation.error}</p>
          <button
            type="button"
            onClick={navigation.retry}
            className="border border-border px-3 py-2 text-sm"
          >
            {t("error.boot.retry", "Retry")}
          </button>
        </div>
      </div>
    );
  }

  // Auto-resuming from URL — show spinner while loading
  if (!state.session && state.executionRecovery) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="w-full max-w-2xl overflow-hidden rounded-(--radius-control) border border-border">
          <ExecutionRecoveryNotice
            recovery={state.executionRecovery}
            onRetry={retryInterruptedTurn}
            onRefresh={refreshExecutionRecovery}
            onStop={abortActiveTurn}
          />
        </div>
      </div>
    );
  }
  if (state.booted && sid && state.session?.id !== sid) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Boot error
  if (state.bootError) {
    return (
      <div className="flex items-center justify-center h-full w-full p-6">
        <div className="max-w-md w-full border border-border p-6 space-y-4">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span className="text-sm font-medium">
              {t("error.boot.title", "Failed to start")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground break-all">
            {state.bootError}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void boot()}
              className="px-3 py-2 text-xs uppercase tracking-widest border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {t("error.boot.retry", "Retry")}
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-2 text-xs uppercase tracking-widest border border-border hover:bg-muted"
            >
              {t("error.boot.reload", "Reload app")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Game view — session is active. GameView reads everything else from the
  // session store itself; the prop just carries this branch's null-narrowing.
  if (state.session) {
    return (
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <GameView
          key={state.session.id}
          session={state.session}
          requestedPanel={panel}
          onPanelHandled={handlePanelHandled}
        />
      </Suspense>
    );
  }

  // Prep screen — world selected but no session yet
  if (state.world) {
    return (
      <SessionPrepScreen
        world={state.world}
        plugins={state.plugins}
        presets={state.presets}
        llmConfig={state.llmConfig}
        startError={state.executionError}
        onBack={backToWorldSelect}
        onStart={startGame}
        onResume={resumeSession}
        onDeleteSession={deleteSession}
        settingsOpen={settings.open}
        onSettingsOpenChange={settings.onOpenChange}
        settingsInitialKey={settings.initialKey}
      />
    );
  }

  // World selection — onboarding wizard is only mounted here so first-time
  // users see it when they click "Get Started" and land on world-select,
  // not on the marketing home page.
  return (
    <>
      <OnboardingWizard
        open={onboardingOpen}
        onOpenChange={setOnboardingOpen}
        settingsOpen={settings.open}
        onOpenSettings={settings.openWithKey}
        resolvedSlots={resolvedSlots}
      />
      <WorldSelectScreen
        onOpenOnboarding={() => setOnboardingOpen(true)}
        worlds={state.worlds}
        plugins={state.plugins}
        resolvedSlots={resolvedSlots}
        settingsOpen={settings.open}
        onSettingsOpenChange={settings.onOpenChange}
        settingsInitialKey={settings.initialKey}
        onSelectWorld={selectWorld}
        onWorldUpdated={updateWorldLocal}
        onWorldCreated={addWorldLocal}
        onWorldDeleted={removeWorldLocal}
      />
    </>
  );
}
