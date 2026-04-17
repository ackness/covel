/**
 * Covel v2 — Plugin-driven UI.
 *
 * Full game flow: world select → session create → narrative streaming → player input
 * Right panel: plugin-driven tabs via json-render
 */

import { useEffect, useMemo, useRef, useState, useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { Loader2 } from "lucide-react";
import { useSessionStore } from "@/stores/session-store.js";
import { WorldSelect } from "@/components/session/world-select.js";
import { SessionPrep } from "@/components/session/session-prep.js";
import { MessageList } from "@/components/chat/message-list.js";
import { InputBar } from "@/components/chat/input-bar.js";
import { RightPanel } from "@/components/panels/right-panel.js";
import { DebugPage } from "@/components/debug/debug-page.js";

function readDebugViewParams(): { active: boolean; sid: string | null } {
  if (typeof window === "undefined") return { active: false, sid: null };
  const params = new URLSearchParams(window.location.search);
  return {
    active: params.get("view") === "debug",
    sid: params.get("sid"),
  };
}

function exitDebugView(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("view");
  url.searchParams.delete("sid");
  window.location.replace(url.toString());
}

const RIGHT_PANEL_WIDTH_KEY = "covel:web-v2:right-panel-width-pct";
const DEFAULT_RIGHT_PANEL_WIDTH = 28;
const MIN_RIGHT_PANEL_PX = 300;
const MAX_RIGHT_PANEL_PX = 680;

function loadInitialRightPanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_RIGHT_PANEL_WIDTH;
  const stored = Number(window.localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
  if (Number.isFinite(stored) && stored >= 18 && stored <= 48) {
    return stored;
  }
  return DEFAULT_RIGHT_PANEL_WIDTH;
}

export function App() {
  const debugView = useMemo(readDebugViewParams, []);
  const store = useSessionStore();
  const layoutRef = useRef<HTMLDivElement>(null);
  const [rightPanelWidthPct, setRightPanelWidthPct] = useState(loadInitialRightPanelWidth);

  useEffect(() => {
    if (debugView.active) return;
    void store.boot();
  }, [debugView.active]);

  useEffect(() => {
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidthPct));
  }, [rightPanelWidthPct]);

  const startRightPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const layout = layoutRef.current;
    if (!layout) return;

    event.preventDefault();
    const rect = layout.getBoundingClientRect();
    const minPct = (MIN_RIGHT_PANEL_PX / rect.width) * 100;
    const maxPct = Math.min(48, (MAX_RIGHT_PANEL_PX / rect.width) * 100);

    const onMove = (moveEvent: PointerEvent) => {
      const nextWidthPx = rect.right - moveEvent.clientX;
      const nextPct = (nextWidthPx / rect.width) * 100;
      const clampedPct = Math.max(minPct, Math.min(maxPct, nextPct));
      setRightPanelWidthPct(clampedPct);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  if (debugView.active) {
    return (
      <DebugPage
        initialSessionId={debugView.sid ?? undefined}
        onExit={exitDebugView}
      />
    );
  }

  // Loading
  if (store.phase === "loading") {
    return (
      <div className="h-screen flex items-center justify-center bg-white dark:bg-zinc-950">
        <Loader2 className="w-6 h-6 text-zinc-400 animate-spin" />
      </div>
    );
  }

  // World select
  if (store.phase === "world-select") {
    return (
      <div className="h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        <WorldSelect worlds={store.worlds} onSelect={store.selectWorld} onResume={store.resumeSession} />
      </div>
    );
  }

  // Session prep — world selected, show details + "开始冒险"
  if (store.phase === "session-prep" && store.selectedWorld) {
    return (
      <div className="h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        <SessionPrep
          world={store.selectedWorld}
          plugins={store.plugins}
          selectedPlugins={store.selectedPlugins}
          pluginFlow={store.pluginFlow}
          worldSessions={store.worldSessions}
          onStart={store.startGame}
          onBack={store.backToWorldSelect}
          onResume={store.resumeSession}
          onDelete={store.deleteSession}
          onTogglePlugin={store.togglePluginSelection}
          onRefreshPlugins={store.refreshPluginCatalog}
        />
      </div>
    );
  }

  // Playing
  return (
    <div className="h-screen flex flex-col bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* Header */}
      <header className="shrink-0 border-b border-zinc-200 dark:border-zinc-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={store.backToWorldSelect}
            className="text-xs font-semibold tracking-wide hover:text-zinc-500 transition-colors"
          >
            COVEL
          </button>
          {store.session && (
            <span className="text-[10px] text-zinc-400 font-mono">
              #{store.session.id.split("-").at(-1)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {store.executing && (
            <div className="flex items-center gap-1.5 text-[10px] text-blue-500">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>执行中...</span>
            </div>
          )}
          {store.session && (
            <span className="text-[10px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 rounded">
              {(store.session?.turnCount ?? 0) === 0 ? "pre-game" : "playing"}
            </span>
          )}
        </div>
      </header>

      {/* Main layout */}
      <div ref={layoutRef} className="flex-1 flex min-h-0">
        {/* Center: message area */}
        <main className="flex-1 flex flex-col min-w-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {store.messages.length === 0 && !store.executing ? (
              <div className="flex items-center justify-center h-full text-zinc-400 text-sm">
                等待游戏开始...
              </div>
            ) : (
              <div className="space-y-4">
                <MessageList
                  messages={store.messages}
                  executionSteps={store.executionSteps}
                  executing={store.executing}
                />
              </div>
            )}
          </div>

          {/* Input */}
          <InputBar
            value={store.composerText}
            onChange={store.setComposerText}
            onSend={() => void store.sendMessage()}
            pendingDrafts={store.pendingInteractionDrafts}
            onRemoveDraft={store.removePendingInteractionDraft}
            disabled={store.executing}
            placeholder={store.executing ? "等待回合结束..." : "输入你的行动..."}
          />

          {/* Error */}
          {store.error && (
            <div className="shrink-0 px-4 py-2 bg-red-50 dark:bg-red-900/10 text-red-600 text-xs border-t border-red-200 dark:border-red-800">
              {store.error}
            </div>
          )}
        </main>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧边栏宽度"
          onPointerDown={startRightPanelResize}
          className="group relative w-3 shrink-0 cursor-col-resize touch-none bg-transparent"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-zinc-200 dark:bg-zinc-700 transition-colors group-hover:bg-blue-500" />
          <div className="absolute left-1/2 top-1/2 h-12 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-300/80 dark:bg-zinc-600/80 transition-colors group-hover:bg-blue-500" />
        </div>

        {/* Right: plugin panels */}
        <aside
          className="shrink-0 border-l border-zinc-200 dark:border-zinc-700 min-w-[300px] max-w-[48%]"
          style={{
            width: `${rightPanelWidthPct}%`,
            flexBasis: `${rightPanelWidthPct}%`,
          }}
        >
          <RightPanel />
        </aside>
      </div>
    </div>
  );
}
