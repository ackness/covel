/**
 * SessionPrep — pre-game preparation screen.
 *
 * Shows world details, plugin list, past sessions for this world, and
 * "开始冒险" / "继续游戏" actions.
 */

import { ArrowLeft, Play, RotateCcw, Trash2, Globe, Puzzle } from "lucide-react";
import type { WorldRecord, PluginInfo, SessionRecord } from "@/stores/session-store.js";

interface SessionPrepProps {
  world: WorldRecord;
  plugins: PluginInfo[];
  worldSessions: SessionRecord[];
  onStart: () => void;
  onBack: () => void;
  onResume: (sessionId: string, worldId: string) => void;
  onDelete: (sessionId: string) => void;
}

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    init: "初始化",
    character_creation: "角色创建",
    playing: "游戏中",
    ended: "已结束",
  };
  return map[phase] ?? phase;
}

function sessionShortId(id: string): string {
  // e.g. "cloudmere-a1b2c3d4" → "a1b2c3d4"
  const parts = id.split("-");
  return parts.at(-1) ?? id.slice(-8);
}

export function SessionPrep({
  world,
  plugins,
  worldSessions,
  onStart,
  onBack,
  onResume,
  onDelete,
}: SessionPrepProps) {
  return (
    <div className="flex items-start justify-center h-full overflow-y-auto py-8">
      <div className="max-w-lg w-full px-6 space-y-5">
        {/* Back */}
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回选择世界
        </button>

        {/* World card */}
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-zinc-400" />
            <h2 className="text-sm font-semibold">{world.name}</h2>
          </div>
          <p className="text-xs text-zinc-500 leading-relaxed">{world.description}</p>
          {world.tags && world.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {world.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[9px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 rounded-sm"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Past sessions */}
        {worldSessions.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">历史存档</h3>
            <div className="space-y-1.5">
              {worldSessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2.5 group"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-zinc-600 dark:text-zinc-300">
                        #{sessionShortId(session.id)}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-sm font-medium ${
                        session.phase === "playing"
                          ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                          : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                      }`}>
                        {phaseLabel(session.phase)}
                      </span>
                    </div>
                    {session.createdAt && (
                      <p className="text-[10px] text-zinc-400">
                        {new Date(session.createdAt).toLocaleString("zh-CN", {
                          month: "numeric", day: "numeric",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-3">
                    <button
                      type="button"
                      onClick={() => onResume(session.id, world.id)}
                      className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:hover:bg-blue-900/40 transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                      继续
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(session.id)}
                      className="flex items-center gap-1 text-[10px] px-2 py-1 rounded text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Plugins */}
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Puzzle className="w-4 h-4 text-zinc-400" />
            <h3 className="text-xs font-medium text-zinc-500">插件 ({plugins.length})</h3>
          </div>
          <div className="space-y-1">
            {plugins.map((p) => (
              <div key={p.name} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                {p.displayName || p.name}
              </div>
            ))}
          </div>
        </div>

        {/* Start new game */}
        <button
          type="button"
          onClick={onStart}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium rounded-lg hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
        >
          <Play className="w-4 h-4" />
          开始新游戏
        </button>
      </div>
    </div>
  );
}
