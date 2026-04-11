/**
 * Covel v2 — Plugin-driven UI.
 *
 * Full game flow: world select → session create → narrative streaming → player input
 * Right panel: plugin-driven tabs via json-render
 */

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useSessionStore } from "@/stores/session-store.js";
import { WorldSelect } from "@/components/session/world-select.js";
import { SessionPrep } from "@/components/session/session-prep.js";
import { MessageList } from "@/components/chat/message-list.js";
import { InputBar } from "@/components/chat/input-bar.js";
import { RightPanel } from "@/components/panels/right-panel.js";

export function App() {
  const store = useSessionStore();

  useEffect(() => {
    store.boot();
  }, []);

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
        <WorldSelect worlds={store.worlds} onSelect={store.selectWorld} />
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
          onStart={store.startGame}
          onBack={store.backToWorldSelect}
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
          <h1 className="text-sm font-semibold tracking-wide">COVEL</h1>
          {store.session && (
            <span className="text-[10px] text-zinc-400 font-mono">
              {store.session.id}
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
              {store.session.phase}
            </span>
          )}
        </div>
      </header>

      {/* Main layout */}
      <div className="flex-1 flex min-h-0">
        {/* Center: message area */}
        <main className="flex-1 flex flex-col min-w-0">
          {/* Execution steps */}
          {store.executionSteps.length > 0 && (
            <div className="shrink-0 border-b border-zinc-200 dark:border-zinc-700 px-4 py-2">
              <div className="flex flex-wrap gap-2">
                {store.executionSteps.map((step) => (
                  <div key={step.runtimeId} className="flex items-center gap-1.5 text-[10px]">
                    {step.status === "running" ? (
                      <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                    ) : step.status === "completed" ? (
                      <span className="w-3 h-3 rounded-full bg-emerald-500 inline-block" />
                    ) : (
                      <span className="w-3 h-3 rounded-full bg-red-500 inline-block" />
                    )}
                    <span className="text-zinc-500">{step.label ?? step.runtimeId}</span>
                    {step.durationMs != null && (
                      <span className="text-zinc-400">{(step.durationMs / 1000).toFixed(1)}s</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {store.messages.length === 0 && !store.executing ? (
              <div className="flex items-center justify-center h-full text-zinc-400 text-sm">
                等待游戏开始...
              </div>
            ) : (
              <MessageList messages={store.messages} />
            )}
          </div>

          {/* Input */}
          <InputBar
            onSend={store.sendMessage}
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

        {/* Right: plugin panels */}
        <aside className="w-72 shrink-0 border-l border-zinc-200 dark:border-zinc-700">
          <RightPanel />
        </aside>
      </div>
    </div>
  );
}
