import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, AlertCircle } from "lucide-react";
import { useSession } from "@/stores/session-store.js";
import { getDataService } from "@/services/data-service.js";
import { mergeChatExportMessages } from "@/lib/chat-export.js";
import { emitToast } from "@/lib/toast-channel.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";
import { useSettingsDialog } from "@/hooks/use-settings-dialog.js";
import { resolveI18n } from "@/lib/catalog.js";
import { initDesktopBridge } from "@/lib/desktop-bridge.js";
import { onNavEvent } from "@/lib/nav-events.js";
import { WorldSelectScreen } from "@/components/session/world-select-screen.js";
import { SessionPrepScreen } from "@/components/session/session-prep-screen.js";
import { OnboardingWizard } from "@/components/onboarding-wizard.js";

// Lazy-load the in-game surface (chat + stage + json-render panels + plugin
// UI) — the single heaviest component tree in the app, but only reachable once
// a session is active. Keeping it out of the main chunk trims first paint for
// the marketing home / world-select / prep screens, which never touch it
// (M-03 bundle budget). Split alongside the already-lazy /debug route.
const GameView = lazy(() =>
  import("@/components/session/game-view.js").then((m) => ({
    default: m.GameView,
  })),
);

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
  const { t } = useTranslation();
  const {
    state,
    boot,
    selectWorld,
    startGame,
    resumeSession,
    resumeSessionById,
    deleteSession,
    backToWorldSelect,
    updateWorldLocal,
    addWorldLocal,
    removeWorldLocal,
  } = useSession();
  const settings = useSettingsDialog();
  const { resolvedSlots } = useSlotConfig(state.presets, state.llmConfig);
  const { sid } = Route.useSearch();
  const navigate = useNavigate();
  const autoResumeAttempted = useRef(false);
  // Tracks the session id currently reflected in the URL. Updated whenever
  // state.session.id matches the URL sid (URL/state are in sync). When the URL
  // drops its sid while state.session still references the matching id, the
  // user navigated back to world select and we clear the session.
  //
  // Initialised from state.session?.id so a stale session carried over from a
  // previous navigation (e.g. user clicked the brand back to /session) is
  // recognised at mount and dropped on the first sync pass.
  const lastSyncedSessionIdRef = useRef<string | null>(
    state.session?.id ?? null,
  );
  useEffect(() => {
    if (state.session?.id && state.session.id === sid) {
      lastSyncedSessionIdRef.current = state.session.id;
    }
  }, [state.session?.id, sid]);

  // Sync URL with session state
  useEffect(() => {
    if (state.session && state.session.id !== sid) {
      if (!sid && state.session.id === lastSyncedSessionIdRef.current) {
        // URL dropped its sid while state.session still references the matching
        // session — user navigated back to world select. Drop the session.
        // Without this the transient render between TanStack Router's URL
        // commit and the queued dispatch would push the sid right back.
        backToWorldSelect();
        lastSyncedSessionIdRef.current = null;
      } else {
        navigate({
          to: "/session",
          search: { sid: state.session.id },
          replace: true,
        });
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
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const messagesRef = useRef(state.messages);
  messagesRef.current = state.messages;
  const sessionIdRef = useRef(state.session?.id);
  sessionIdRef.current = state.session?.id;
  const tRef = useRef(t);
  tRef.current = t;

  // Topbar nav → in-page panel toggles. The global topbar lives in __root and
  // can't reach page-local state directly, so it dispatches via nav-events.
  useEffect(() => {
    return onNavEvent((event) => {
      if (event === "open-plugins") {
        settings.openWithKey("plugin");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              .map((m) => `[${m.role}] ${m.content}`)
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
        <GameView session={state.session} />
      </Suspense>
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
      <OnboardingWizard />
      <WorldSelectScreen
        worlds={state.worlds}
        packages={state.packages}
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
