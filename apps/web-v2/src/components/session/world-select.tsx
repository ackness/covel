/**
 * WorldSelect — choose a world to start the game.
 */

import { Globe, ArrowRight } from "lucide-react";
import type { WorldRecord } from "@/services/api.js";

interface WorldSelectProps {
  worlds: WorldRecord[];
  onSelect: (worldId: string) => void;
}

export function WorldSelect({ worlds, onSelect }: WorldSelectProps) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="max-w-lg w-full px-6 space-y-6">
        <div className="text-center space-y-2">
          <Globe className="w-8 h-8 text-zinc-400 mx-auto" />
          <h1 className="text-lg font-semibold">选择世界</h1>
          <p className="text-xs text-zinc-500">选择一个世界开始你的冒险</p>
        </div>
        <div className="space-y-3">
          {worlds.map((world) => (
            <button
              key={world.id}
              type="button"
              onClick={() => onSelect(world.id)}
              className="w-full text-left p-4 border border-zinc-200 dark:border-zinc-700 rounded-lg hover:border-blue-400 hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h3 className="text-sm font-medium">{world.name}</h3>
                  <p className="text-xs text-zinc-500 leading-relaxed">{world.description}</p>
                  {world.tags && (
                    <div className="flex gap-1 pt-1">
                      {world.tags.map((tag) => (
                        <span key={tag} className="text-[9px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 rounded-sm">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <ArrowRight className="w-4 h-4 text-zinc-300 group-hover:text-blue-500 transition-colors shrink-0 ml-4" />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
