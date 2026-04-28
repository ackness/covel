/**
 * DatabasePanel — live view of the current session's state tables.
 *
 * Replaces the old State-Patches list with a "ledger" of grouped sections:
 *   - § 核心 — built-in tables (`session`, `characters`, …)
 *   - § 插件 — `plugin_data/*` tables grouped by pluginId, then namespace
 *
 * Layout follows the editorial design system (ui-folio + ui-section-head +
 * flat hairline rows) so the panel reads as a printed index rather than a
 * stack of bordered cards.
 *
 * Data source: GET /api/sessions/:id/state
 * Auto-refreshes whenever a new `state.changed` SSE event bumps `refreshKey`
 * from the parent (session store exposes statePatches).
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { listStateTables, type StateTableEntry } from "@/services/api.js";

const PLUGIN_DATA_PREFIX = "plugin_data/";

interface ParsedTableName {
  kind: "core" | "plugin";
  pluginId?: string;
  namespace?: string;
  fullName: string;
}

/**
 * Break long internal table names into a display-friendly tuple.
 *
 *   `session`                                 → core
 *   `plugin_data/core-codex:__ui_right__`     → plugin · core-codex · ui_right
 *   `plugin_data/dashscope-image-gen:gallery` → plugin · dashscope-image-gen · gallery
 *
 * Surrounding `__` markers (used internally to namespace UI mounts) are
 * stripped from the display only — the original `fullName` stays available
 * via the `title` attribute for inspection.
 */
function parseTableName(name: string): ParsedTableName {
  if (!name.startsWith(PLUGIN_DATA_PREFIX)) {
    return { kind: "core", fullName: name };
  }
  const rest = name.slice(PLUGIN_DATA_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon < 0) {
    return { kind: "plugin", pluginId: rest, fullName: name };
  }
  const pluginId = rest.slice(0, colon);
  const rawNamespace = rest.slice(colon + 1);
  const namespace = rawNamespace.replace(/^__/, "").replace(/__$/, "");
  return { kind: "plugin", pluginId, namespace: namespace || undefined, fullName: name };
}

interface ParsedTable {
  table: StateTableEntry;
  parsed: ParsedTableName;
}

interface PluginGroup {
  pluginId: string;
  rows: ParsedTable[];
}

function groupTables(tables: StateTableEntry[]): {
  core: ParsedTable[];
  plugins: PluginGroup[];
} {
  const core: ParsedTable[] = [];
  const pluginMap = new Map<string, ParsedTable[]>();
  for (const table of tables) {
    const parsed = parseTableName(table.name);
    if (parsed.kind === "core") {
      core.push({ table, parsed });
      continue;
    }
    const pid = parsed.pluginId ?? "(unknown)";
    const list = pluginMap.get(pid) ?? [];
    list.push({ table, parsed });
    pluginMap.set(pid, list);
  }
  const plugins: PluginGroup[] = Array.from(pluginMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pluginId, rows]) => ({ pluginId, rows }));
  return { core, plugins };
}

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

  const { core, plugins } = useMemo(() => groupTables(tables), [tables]);

  return (
    <div className="space-y-4 min-w-0">
      <header className="flex items-center justify-between gap-2 min-w-0 pb-2 border-b border-[var(--rule-color)]">
        <span className="ui-folio truncate">
          DATABASE&nbsp;&nbsp;<em className="not-italic">共 {tables.length} 卷</em>
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={handleRefresh}
          disabled={loading}
          title={t("session.refresh")}
        >
          {loading
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <RefreshCw className="w-3 h-3" />}
        </Button>
      </header>

      {error && (
        <div className="text-[11px] border border-destructive/40 bg-destructive/5 text-destructive p-2 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="italic break-all">
              {t("session.dbLoadError")}: {error}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2 shrink-0"
              onClick={handleRefresh}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              <span className="ml-1">{t("session.retry", "Retry")}</span>
            </Button>
          </div>
        </div>
      )}

      {!loading && !error && tables.length === 0 && (
        <p className="ui-empty-copy text-xs">
          {t("session.dbEmpty")}
        </p>
      )}

      {core.length > 0 && (
        <Section ord="§ 核心" title="State" count={core.length}>
          <RowList>
            {core.map(({ table, parsed }) => (
              <TableRow key={table.name} table={table} parsed={parsed} />
            ))}
          </RowList>
        </Section>
      )}

      {plugins.length > 0 && (
        <Section
          ord="§ 插件"
          title="Plugin Data"
          count={plugins.reduce((acc, g) => acc + g.rows.length, 0)}
          subCount={plugins.length}
        >
          <div className="space-y-3 min-w-0">
            {plugins.map((group) => (
              <PluginGroupView key={group.pluginId} group={group} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

interface SectionProps {
  ord: string;
  title: string;
  count: number;
  subCount?: number;
  children: React.ReactNode;
}

function Section({ ord, title, count, subCount, children }: SectionProps) {
  return (
    <section className="space-y-2 min-w-0">
      <div className="ui-section-head">
        <span className="ui-eyebrow">{ord}</span>
        <span className="ui-section-title">{title}</span>
        <div className="flex-1" />
        <span className="ui-section-count">
          {subCount != null ? `${subCount} · ` : ""}
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

function RowList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="border-t border-[var(--rule-color)] min-w-0">
      {children}
    </ul>
  );
}

function PluginGroupView({ group }: { group: PluginGroup }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 min-w-0 px-0.5 pb-1">
        <span className="font-mono text-[11px] font-medium tracking-tight truncate text-foreground">
          {group.pluginId}
        </span>
        <span className="ui-section-count shrink-0">{group.rows.length}</span>
      </div>
      <RowList>
        {group.rows.map(({ table, parsed }) => (
          <TableRow key={table.name} table={table} parsed={parsed} compact />
        ))}
      </RowList>
    </div>
  );
}

interface TableRowProps {
  table: StateTableEntry;
  parsed: ParsedTableName;
  /** When true, the row hides its kind badge (used inside grouped plugin lists). */
  compact?: boolean;
}

function TableRow({ table, parsed, compact = false }: TableRowProps) {
  const [open, setOpen] = useState(false);
  const fieldCount = table.fields.length;
  const valueCount = Object.keys(table.data).length;

  const label = compact
    ? parsed.namespace ?? parsed.pluginId ?? parsed.fullName
    : parsed.kind === "core"
      ? parsed.fullName
      : parsed.namespace
        ? `${parsed.pluginId}·${parsed.namespace}`
        : parsed.pluginId ?? parsed.fullName;

  return (
    <li className="border-b border-[var(--rule-color)] min-w-0 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-1 py-1.5 text-left hover:bg-[color-mix(in_oklab,var(--surface-inset)_60%,transparent)] transition-colors"
        title={parsed.fullName}
        aria-expanded={open}
      >
        <ChevronRight
          className={`w-3 h-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="flex-1 min-w-0 truncate font-mono text-[11px]">
          {label}
        </span>
        <span className="ui-meta shrink-0 tabular-nums">
          {fieldCount}f · {valueCount}v
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 min-w-0 overflow-hidden bg-[color-mix(in_oklab,var(--surface-inset)_45%,transparent)] border-t border-[var(--rule-color)]">
          {fieldCount > 0 && (
            <SchemaList fields={table.fields} />
          )}
          <ValuesBlock data={table.data} valueCount={valueCount} />
        </div>
      )}
    </li>
  );
}

function SchemaList({ fields }: { fields: StateTableEntry["fields"] }) {
  return (
    <div className="space-y-1 min-w-0">
      <span className="ui-eyebrow">Schema</span>
      <ul className="space-y-0.5 min-w-0">
        {fields.map((f) => (
          <li
            key={f.name}
            className="text-[10px] flex items-baseline gap-2 min-w-0"
            title={f.description ? `${f.name} — ${f.description}` : f.name}
          >
            <span className="font-mono truncate text-foreground/90 shrink-[2] basis-auto">
              {f.name}
            </span>
            {f.type && (
              <span className="ui-meta shrink-0 tabular-nums lowercase">
                {f.type}
              </span>
            )}
            {f.description && (
              <span className="text-muted-foreground italic truncate flex-1 min-w-0">
                — {f.description}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ValuesBlock({ data, valueCount }: { data: unknown; valueCount: number }) {
  return (
    <div className="space-y-1 min-w-0">
      <span className="ui-eyebrow">Values</span>
      {valueCount === 0 ? (
        <p className="ui-empty-copy text-[10px]">(empty)</p>
      ) : (
        <pre className="max-h-[200px] max-w-full overflow-auto p-2 text-[10px] font-mono leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere] bg-[var(--surface-inset)] border border-[var(--rule-color)] rounded-sm">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
