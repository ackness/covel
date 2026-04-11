/**
 * Covel v2 — Plugin-driven UI prototype.
 *
 * This app demonstrates the decoupled plugin UI system:
 * - Right panel tabs are dynamically registered from /api/ui-specs
 * - Panel content is rendered via json-render from plugin JSON specs
 * - Plugin data flows through SSE events in real-time
 */

import { useEffect, useState } from "react";
import { RightPanel } from "@/components/panels/right-panel.js";
import { fetchHealth } from "@/services/api.js";

export function App() {
  const [serverStatus, setServerStatus] = useState<"connecting" | "connected" | "error">("connecting");

  useEffect(() => {
    fetchHealth()
      .then(() => setServerStatus("connected"))
      .catch(() => setServerStatus("error"));
  }, []);

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* Header */}
      <header className="shrink-0 border-b border-zinc-200 dark:border-zinc-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold tracking-wide">COVEL v2</h1>
          <span className="text-[10px] text-zinc-400 uppercase tracking-widest">Plugin UI Prototype</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${
            serverStatus === "connected" ? "bg-emerald-500" :
            serverStatus === "error" ? "bg-red-500" : "bg-amber-500 animate-pulse"
          }`} />
          <span className="text-[10px] text-zinc-500">
            {serverStatus === "connected" ? "Server connected" :
             serverStatus === "error" ? "Server offline" : "Connecting..."}
          </span>
        </div>
      </header>

      {/* Main layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel placeholder */}
        <aside className="w-60 shrink-0 border-r border-zinc-200 dark:border-zinc-700 p-4">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest mb-3">Plugins</h2>
          <p className="text-[11px] text-zinc-400 italic">Plugin config will appear here</p>
        </aside>

        {/* Center panel placeholder */}
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center text-zinc-400 space-y-2">
            <p className="text-sm">Message area</p>
            <p className="text-[11px]">Game chat and inline blocks will render here</p>
          </div>
        </main>

        {/* Right panel — plugin-driven */}
        <aside className="w-80 shrink-0 border-l border-zinc-200 dark:border-zinc-700">
          <RightPanel />
        </aside>
      </div>
    </div>
  );
}
