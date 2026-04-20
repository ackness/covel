/**
 * LorebookPanel — framework-owned right-panel tab for session-level lorebook
 * entries. Lets the player view, toggle, or delete entries.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
      setError(err instanceof Error ? err.message : String(err));
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
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  async function onToggleEnabled(entry: LorebookEntry) {
    setPending((prev) => ({ ...prev, [entry.id]: true }));
    const nextEnabled = !entry.enabled;
    setEntries((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, enabled: nextEnabled } : e)),
    );
    try {
      await updateLorebookEntryEnabled(sessionId, entry.id, nextEnabled);
    } catch (err) {
      setEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, enabled: entry.enabled } : e)),
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
    if (!window.confirm(t("lorebook.deleteConfirm", { id: entry.id }))) return;
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
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-display font-semibold flex items-center gap-2 text-sm uppercase tracking-widest">
          <BookOpen className="w-4 h-4 shrink-0" /> {t("lorebook.title")}
        </h3>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          title={t("lorebook.refresh")}
          className="p-1 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
        >
          <RefreshCw className={clsx("w-3.5 h-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {error && (
        <div className="text-xs text-destructive px-2 py-1.5 rounded bg-destructive/10">
          {error}
        </div>
      )}

      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center h-20 text-muted-foreground text-xs">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex items-center justify-center h-20 text-muted-foreground text-xs">
          {t("lorebook.noEntries")}
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
  const { t } = useTranslation();
  const preview = entry.content.length > 120
    ? entry.content.slice(0, 120) + "…"
    : entry.content;

  return (
    <div
      className={clsx(
        "rounded-md border text-xs transition-opacity",
        entry.enabled
          ? "border-border bg-card"
          : "border-border bg-muted/50 opacity-60",
      )}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-[11px] text-foreground truncate">
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
            <span className="text-[9px] text-muted-foreground font-mono">
              #{entry.insertionOrder}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground truncate">
            {entry.pluginId} · {entry.position}
          </div>
          {entry.keys.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {entry.keys.slice(0, 6).map((k) => (
                <span key={k} className="px-1 py-px rounded bg-muted text-[9px] text-muted-foreground font-mono">
                  {k}
                </span>
              ))}
              {entry.keys.length > 6 && (
                <span className="text-[9px] text-muted-foreground">+{entry.keys.length - 6}</span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            disabled={pending}
            onClick={onToggleEnabled}
            title={entry.enabled ? t("lorebook.disable") : t("lorebook.enable")}
            className={clsx(
              "w-8 h-4 rounded-full relative transition-colors disabled:opacity-50",
              entry.enabled ? "bg-emerald-500" : "bg-muted-foreground/30",
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
            title={t("lorebook.delete")}
            className="p-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="px-2.5 pb-2 pt-0">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="w-full text-left text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
        >
          {expanded ? entry.content : preview}
        </button>
        {entry.content.length > 120 && (
          <button
            type="button"
            onClick={onToggleExpanded}
            className="mt-1 text-[10px] text-primary hover:underline"
          >
            {expanded ? t("lorebook.collapse") : t("lorebook.expand")}
          </button>
        )}
      </div>
    </div>
  );
}
