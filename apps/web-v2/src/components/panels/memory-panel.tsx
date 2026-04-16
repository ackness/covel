/**
 * MemoryPanel — Displays core memory blocks (Letta-style three-tier memory).
 *
 * Framework-owned panel that shows the current state of the 4 core memory
 * blocks: story_state, scene, character_relationships, player_profile.
 * Refreshes on each turn via polling.
 */

import { useState, useEffect, useCallback } from "react";
import * as Icons from "lucide-react";
import { clsx } from "clsx";
import { apiClient } from "@/services/api.js";

interface CoreMemoryBlock {
  label: string;
  content: string;
  updatedAt: string;
}

const LABEL_NAMES: Record<string, string> = {
  story_state: "剧情状态",
  scene: "当前场景",
  character_relationships: "角色关系",
  player_profile: "玩家状态",
};

const LABEL_ICONS: Record<string, Icons.LucideIcon> = {
  story_state: Icons.BookOpen,
  scene: Icons.MapPin,
  character_relationships: Icons.Users,
  player_profile: Icons.User,
};

export function MemoryPanel({ sessionId }: { sessionId: string }) {
  const [blocks, setBlocks] = useState<CoreMemoryBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);

  const loadBlocks = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/core-memory`);
      if (!res.ok) {
        if (res.status === 404) {
          setError("Memory 系统未启用");
          setBlocks([]);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { blocks: CoreMemoryBlock[] };
      setBlocks(data.blocks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadBlocks();
    // Poll every 10s to catch async memory updates
    const interval = setInterval(loadBlocks, 10000);
    return () => clearInterval(interval);
  }, [loadBlocks]);

  if (loading) {
    return (
      <div className="text-xs text-zinc-400 p-3">
        加载核心记忆...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-zinc-400 p-3">
        <Icons.AlertCircle className="w-4 h-4 inline mr-1" />
        {error}
      </div>
    );
  }

  const nonEmptyBlocks = blocks.filter((b) => b.content && b.content.trim());
  const emptyBlocks = blocks.filter((b) => !b.content || !b.content.trim());

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
          核心记忆
        </span>
        <button
          type="button"
          onClick={loadBlocks}
          className="text-zinc-400 hover:text-zinc-600 transition-colors"
          title="刷新"
        >
          <Icons.RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <p className="text-[11px] text-zinc-400 leading-relaxed">
        Letta 式记忆管理。每轮结束后自动更新，保存关键剧情、场景和角色信息。
      </p>

      {nonEmptyBlocks.length === 0 && (
        <div className="text-xs text-zinc-400 italic py-4 text-center">
          记忆块尚未初始化，等待首轮游戏结束后自动填充...
        </div>
      )}

      {nonEmptyBlocks.map((block) => {
        const LabelIcon = LABEL_ICONS[block.label] ?? Icons.FileText;
        const isExpanded = expandedBlock === block.label;
        const contentPreview = block.content.length > 100
          ? block.content.slice(0, 100) + "..."
          : block.content;

        return (
          <div
            key={block.label}
            className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden"
          >
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
              onClick={() => setExpandedBlock(isExpanded ? null : block.label)}
            >
              <LabelIcon className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 flex-1 text-left">
                {LABEL_NAMES[block.label] ?? block.label}
              </span>
              <span className="text-[10px] text-zinc-400">
                {block.content.length} 字
              </span>
              {isExpanded ? (
                <Icons.ChevronUp className="w-3 h-3 text-zinc-400" />
              ) : (
                <Icons.ChevronDown className="w-3 h-3 text-zinc-400" />
              )}
            </button>

            {isExpanded ? (
              <div className="px-3 pb-3 border-t border-zinc-100 dark:border-zinc-700/50">
                <pre className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap leading-relaxed mt-2 font-sans">
                  {block.content}
                </pre>
                <div className="text-[10px] text-zinc-400 mt-2">
                  更新于 {new Date(block.updatedAt).toLocaleTimeString("zh-CN")}
                </div>
              </div>
            ) : (
              <div className="px-3 pb-2 border-t border-zinc-100 dark:border-zinc-700/50">
                <p className="text-[11px] text-zinc-500 mt-1.5 line-clamp-2">
                  {contentPreview}
                </p>
              </div>
            )}
          </div>
        );
      })}

      {emptyBlocks.length > 0 && nonEmptyBlocks.length > 0 && (
        <div className="text-[10px] text-zinc-400 pt-1">
          {emptyBlocks.map((b) => LABEL_NAMES[b.label] ?? b.label).join("、")} 暂无内容
        </div>
      )}
    </div>
  );
}
