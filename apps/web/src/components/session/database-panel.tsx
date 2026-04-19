/**
 * DatabasePanel — live view of the current session's state tables.
 *
 * Replaces the old State-Patches list with a proper DB browser:
 *   - One accordion section per state table
 *   - Field schema (name, type, description)
 *   - Current key → value map (JSON-rendered)
 *
 * Data source: GET /api/sessions/:id/state
 * Auto-refreshes whenever a new `state.changed` SSE event bumps
 * `refreshKey` from the parent (session store exposes statePatches).
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Database, RefreshCw, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { listStateTables, type StateTableEntry } from "@/services/api.js";

interface DatabasePanelProps {
  sessionId: string;
  /**
   * Monotonic counter driven by state SSE events — when it changes the
   * panel refetches the snapshot. Parent passes `statePatches.length` or
   * similar so we stay fresh without subscribing to the event bus here.
   */
  refreshKey?: number;
}

export function DatabasePanel({ sessionId, refreshKey = 0 }: DatabasePanelProps) {
  const { t } = useTranslation();
  const [tables, setTables] = useState<StateTableEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    listStateTables(sessionId)
      .then((rows) => {
        if (cancelled) return;
        setTables(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  const handleRefresh = () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    listStateTables(sessionId)
      .then((rows) => {
        setTables(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[10px] rounded-none">
            {tables.length} {t("session.dbTables", "张表")}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleRefresh}
          disabled={loading}
          title={t("session.refresh", "刷新")}
        >
          {loading
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <RefreshCw className="w-3 h-3" />}
        </Button>
      </div>

      {error && (
        <p className="text-[11px] text-red-500 italic">
          {t("session.dbLoadError", "加载失败")}: {error}
        </p>
      )}

      {!loading && !error && tables.length === 0 && (
        <p className="text-xs text-muted-foreground italic">
          {t("session.dbEmpty", "尚无任何状态表。插件产生数据后会在这里显示。")}
        </p>
      )}

      <div className="space-y-1">
        {tables.map((table) => (
          <TableSection key={table.name} table={table} />
        ))}
      </div>
    </div>
  );
}

function TableSection({ table }: { table: StateTableEntry }) {
  const [open, setOpen] = useState(false);
  const fieldCount = table.fields.length;
  const valueCount = Object.keys(table.data).length;

  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold hover:bg-muted/40 transition-colors text-left"
      >
        <ChevronRight className={`w-3 h-3 transition-transform shrink-0 ${open ? "rotate-90" : ""}`} />
        <Database className="w-3 h-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-mono">{table.name}</span>
        <Badge variant="outline" className="text-[9px] rounded-none py-0 h-4">
          {fieldCount}f · {valueCount}v
        </Badge>
      </button>
      {open && (
        <div className="border-t border-border bg-muted/20 px-2 py-2 space-y-2">
          {fieldCount > 0 && (
            <div className="space-y-0.5">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Schema</span>
              <ul className="space-y-0.5">
                {table.fields.map((f) => (
                  <li key={f.name} className="text-[10px] flex items-center gap-1">
                    <span className="font-mono">{f.name}</span>
                    {f.type && (
                      <Badge variant="outline" className="text-[9px] rounded-none py-0 h-3.5">
                        {f.type}
                      </Badge>
                    )}
                    {f.description && (
                      <span className="text-muted-foreground truncate">— {f.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-0.5">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Values</span>
            {valueCount === 0 ? (
              <p className="text-[10px] text-muted-foreground italic">(empty)</p>
            ) : (
              <pre className="text-[10px] font-mono leading-snug whitespace-pre-wrap break-all bg-background/40 rounded-sm p-1.5 border border-border/50 max-h-[200px] overflow-y-auto">
                {JSON.stringify(table.data, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
