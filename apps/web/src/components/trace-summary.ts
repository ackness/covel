import React, { createElement } from "react";

import { useI18n } from "../i18n.js";
import type { TraceRecord } from "../types.js";

export function TraceSummary(input: {
  traceId: string | null;
  entries: TraceRecord[];
}) {
  const { t } = useI18n();

  return createElement(
    "section",
    { className: "panel-section" },
    createElement("div", { className: "eyebrow" }, t("trace.recent")),
    createElement("div", { className: "session-card" }, input.traceId ?? t("trace.none")),
    createElement(
      "ul",
      { className: "stack-list" },
      ...input.entries.map((entry) =>
        createElement(
          "li",
          {
            key: entry.spanId,
            className: "package-row"
          },
          createElement("span", null, `${entry.component} / ${entry.eventType}`)
        )
      )
    )
  );
}
