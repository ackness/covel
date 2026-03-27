import React, { createElement } from "react";

import { useI18n } from "../i18n.js";
import type { TraceRecord } from "../types.js";

export function TraceSummary(input: {
  traceId: string | null;
  entries: TraceRecord[];
}) {
  const { t } = useI18n();
  const groupedTurns = groupTraceEntriesByTurn(input.entries);
  const latestTurnId = groupedTurns[0]?.turnId ?? null;

  return createElement(
    "section",
    { className: "panel-section" },
    createElement("div", { className: "eyebrow" }, t("trace.recent")),
    createElement("div", { className: "session-card" }, input.traceId ?? t("trace.none")),
    createElement(
      "ul",
      { className: "stack-list" },
      ...groupedTurns.map((group) =>
        createElement(
          "li",
          { key: group.turnId },
          createElement(
            "details",
            {
              className: "detail-disclosure",
              open: latestTurnId === group.turnId ? true : undefined
            },
            createElement(
              "summary",
              { className: "detail-summary" },
              createElement("span", null, `${group.turnId} · ${group.entries.length}`),
              createElement("span", { className: "workspace-meta" }, group.latestCreatedAt)
            ),
            createElement(
              "ul",
              { className: "detail-body" },
              ...group.entries.map((entry) =>
                createElement(
                  "li",
                  { key: entry.spanId, className: "runtime-row" },
                  createElement("strong", null, `${entry.component} / ${entry.eventType}`),
                  createElement("span", { className: "workspace-meta" }, entry.spanId),
                  createElement("span", { className: "workspace-meta" }, String(entry.createdAt)),
                  createElement("pre", { className: "payload-preview" }, JSON.stringify(entry.payload, null, 2))
                )
              )
            )
          )
        )
      )
    )
  );
}

function groupTraceEntriesByTurn(entries: TraceRecord[]) {
  const groups = new Map<string, TraceRecord[]>();

  for (const entry of entries) {
    const group = groups.get(entry.turnId) ?? [];
    group.push(entry);
    groups.set(entry.turnId, group);
  }

  return Array.from(groups.entries())
    .map(([turnId, groupedEntries]) => {
      const sortedEntries = [...groupedEntries].sort((left, right) =>
        String(right.createdAt).localeCompare(String(left.createdAt))
      );

      return {
        turnId,
        entries: sortedEntries,
        latestCreatedAt: String(sortedEntries[0]?.createdAt ?? "")
      };
    })
    .sort((left, right) => right.latestCreatedAt.localeCompare(left.latestCreatedAt));
}
