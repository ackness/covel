/**
 * LorebookPanel — framework-owned right-panel tab for session-level lorebook
 * entries.
 *
 * Unlike plugin panels (which are spec-driven via /api/ui-specs), this tab is
 * hardcoded in the framework because the lorebook is a framework capability,
 * not a plugin. It reads from /api/sessions/:id/lorebook and lets the player
 * view, toggle, or delete individual session-scoped entries.
 *
 * Data loading strategy (MVP): fetch on mount + manual refresh button.
 * No dedicated SSE event yet; the lorebook table is written through the
 * proposal commit path and we accept eventual consistency between turns.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2, BookOpen } from "lucide-react";
import { clsx } from "clsx";
import {
  fetchLorebookEntries,
  updateLorebookEntryEnabled,
  deleteLorebookEntry,
  type LorebookEntry,
} from "@/services/api.js";

interface LorebookPanelProps {
  sessionId: string;
}

export function LorebookPanel({ sessionId }: LorebookPanelProps) {
  const [entries, setEntries] = useState<LorebookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchLorebookEntries(sessionId);
      setEntries(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setExpanded({});
    setPending({});
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const next = await fetchLorebookEntries(sessionId);
        if (cancelled) return;
        setEntries(next);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function onToggleEnabled(entry: LorebookEntry) {
    setPending((prev) => ({ ...prev, [entry.id]: true }));
    const nextEnabled = !entry.enabled;
    // Optimistic update — roll back on error.
    setEntries((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, enabled: nextEnabled } : e)),
    );
    try {
      await updateLorebookEntryEnabled(sessionId, entry.id, nextEnabled);
    } catch (err) {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id ? { ...e, enabled: entry.enabled } : e,
        ),
      );
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
    }
  }

  async function onDelete(entry: LorebookEntry) {
    if (!window.confirm(`删除词条 "${entry.id}"？此操作无法撤销。`)) return;
    setPending((prev) => ({ ...prev, [entry.id]: true }));
    const previous = entries;
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    try {
      await deleteLorebookEntry(sessionId, entry.id);
    } catch (err) {
      setEntries(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with refresh */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wider">
          <BookOpen className="w-3 h-3" />
          Lorebook
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          title="刷新"
          className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 disabled:opacity-50"
        >
          <RefreshCw
            className={clsx("w-3 h-3", loading && "animate-spin")}
          />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && (
          <div className="text-xs text-red-600 dark:text-red-400 px-2 py-1.5 rounded bg-red-50 dark:bg-red-900/20">
            {error}
          </div>
        )}

        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-zinc-400 text-xs">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-zinc-400 text-xs">
            尚无 session lorebook 词条
          </div>
        ) : (
          entries.map((entry) => (
            <LorebookEntryCard
              key={entry.id}
              entry={entry}
              expanded={expanded[entry.id] ?? false}
              pending={pending[entry.id] ?? false}
              onToggleExpanded={() => toggleExpanded(entry.id)}
              onToggleEnabled={() => onToggleEnabled(entry)}
              onDelete={() => onDelete(entry)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface LorebookEntryCardProps {
  entry: LorebookEntry;
  expanded: boolean;
  pending: boolean;
  onToggleExpanded: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}

function LorebookEntryCard({
  entry,
  expanded,
  pending,
  onToggleExpanded,
  onToggleEnabled,
  onDelete,
}: LorebookEntryCardProps) {
  const preview = entry.content.length > 120
    ? entry.content.slice(0, 120) + "…"
    : entry.content;

  return (
    <div
      className={clsx(
        "rounded-md border text-xs transition-opacity",
        entry.enabled
          ? "border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
          : "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 opacity-60",
      )}
    >
      {/* Header row */}
      <div className="flex items-start gap-2 px-2.5 py-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-200 truncate">
              {entry.id}
            </span>
            <span
              className={clsx(
                "px-1 py-px rounded text-[9px] uppercase tracking-wider font-medium",
                entry.strategy === "constant"
                  ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                  : "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300",
              )}
            >
              {entry.strategy}
            </span>
            <span className="text-[9px] text-zinc-400 font-mono">
              #{entry.insertionOrder}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-400 truncate">
            {entry.pluginId} · {entry.position}
          </div>
          {entry.keys.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {entry.keys.slice(0, 6).map((k) => (
                <span
                  key={k}
                  className="px-1 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-[9px] text-zinc-600 dark:text-zinc-300 font-mono"
                >
                  {k}
                </span>
              ))}
              {entry.keys.length > 6 && (
                <span className="text-[9px] text-zinc-400">
                  +{entry.keys.length - 6}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            disabled={pending}
            onClick={onToggleEnabled}
            title={entry.enabled ? "禁用" : "启用"}
            className={clsx(
              "w-8 h-4 rounded-full relative transition-colors disabled:opacity-50",
              entry.enabled
                ? "bg-emerald-500"
                : "bg-zinc-300 dark:bg-zinc-600",
            )}
          >
            <span
              className={clsx(
                "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all",
                entry.enabled ? "left-[18px]" : "left-0.5",
              )}
            />
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onDelete}
            title="删除"
            className="p-1 text-zinc-400 hover:text-red-500 disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-2.5 pb-2 pt-0">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="w-full text-left text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap break-words"
        >
          {expanded ? entry.content : preview}
        </button>
        {entry.content.length > 120 && (
          <button
            type="button"
            onClick={onToggleExpanded}
            className="mt-1 text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
          >
            {expanded ? "收起" : "展开"}
          </button>
        )}
      </div>
    </div>
  );
}
