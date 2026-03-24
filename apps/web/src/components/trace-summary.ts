import React, { createElement } from "react";

import type { TraceRecord } from "../types.js";

export function TraceSummary(input: {
  traceId: string | null;
  entries: TraceRecord[];
}) {
  return createElement(
    "section",
    { className: "panel-section" },
    createElement("div", { className: "eyebrow" }, "Recent trace"),
    createElement("div", { className: "session-card" }, input.traceId ?? "No trace"),
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
