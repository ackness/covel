import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummaryEntry, SessionSummaryModel } from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { useUiSlot } from "@/stores/ui-slot-store.js";
import { MeterBar, type PlayerStatus } from "./player-status.js";

/** A line as it is drawn, with its text already in the interface language. */
type SummaryLine =
  | { kind: "text"; id: string; label: string; value: string; tone?: string }
  | {
      kind: "meter";
      id: string;
      label: string;
      value: number;
      min: number;
      max: number;
      tone?: string;
    }
  | { kind: "list"; id: string; label: string; items: string[]; more: number };

function toLine(entry: SessionSummaryEntry, locale: string): SummaryLine {
  const label = resolveDisplayText(entry.label, locale);
  if (entry.kind === "text")
    return {
      kind: "text",
      id: entry.id,
      label,
      value: resolveDisplayText(entry.value, locale),
      tone: entry.tone,
    };
  if (entry.kind === "meter") {
    const min = entry.min ?? 0;
    const max = Math.max(entry.max, min + 1);
    return {
      kind: "meter",
      id: entry.id,
      label,
      value: Math.min(max, Math.max(min, entry.value)),
      min,
      max,
      tone: entry.tone,
    };
  }
  const items = entry.items
    .map((item) => resolveDisplayText(item, locale))
    .filter(Boolean);
  return {
    kind: "list",
    id: entry.id,
    label,
    items,
    more: Math.max(0, (entry.total ?? items.length) - items.length),
  };
}

/**
 * What plugins put in the `session.summary@1` slot — the current objective,
 * the time, what is carried — ready to draw. Any plugin may provide entries;
 * nothing here knows which one did. A later entry with the same id replaces
 * an earlier one.
 */
export function useSessionSummary(sessionId: string): readonly SummaryLine[] {
  const { i18n } = useTranslation();
  const summary = useUiSlot(sessionId, "session.summary@1")?.value as
    SessionSummaryModel | null | undefined;
  return useMemo(() => {
    const lines = new Map<string, SummaryLine>();
    for (const entry of summary?.entries ?? []) {
      const line = toLine(entry, i18n.language);
      if (line.kind === "list" && line.items.length === 0) continue;
      lines.set(line.id, line);
    }
    return [...lines.values()];
  }, [summary, i18n.language]);
}

/** The player's unbounded stats, as lines of the same list. */
export function readoutLines(status: PlayerStatus | null): SummaryLine[] {
  return (status?.readouts ?? []).map((readout) => ({
    kind: "text",
    id: `stat:${readout.id}`,
    label: readout.label,
    value: String(readout.value),
  }));
}

/** Label–value rows; the caller owns the surrounding surface. */
export function SummaryLines({
  lines,
}: {
  readonly lines: readonly SummaryLine[];
}) {
  if (lines.length === 0) return null;
  return (
    <dl className="ui-summary grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-xs">
      {lines.map((line) => (
        <Fragment key={line.id}>
          <dt
            className="ui-summary-label max-w-36 truncate text-muted-foreground"
            title={line.label}
          >
            {line.label}
          </dt>
          <dd
            className="ui-summary-value min-w-0"
            data-tone={"tone" in line ? line.tone : undefined}
          >
            {line.kind === "text" && line.value}
            {line.kind === "meter" && (
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <MeterBar meter={line} />
                </span>
                <span className="shrink-0 tabular-nums">
                  {line.value} / {line.max}
                </span>
              </span>
            )}
            {line.kind === "list" && (
              <ul className="ui-status-items flex flex-wrap gap-1.5">
                {line.items.map((item, index) => (
                  // Items are free text and may repeat.
                  <li key={`${index}:${item}`} className="ui-status-item">
                    {item}
                  </li>
                ))}
                {line.more > 0 && (
                  <li className="ui-status-item">+{line.more}</li>
                )}
              </ul>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
