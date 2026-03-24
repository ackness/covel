import React, { createElement } from "react";

import type { ArchiveVersion } from "../../../../modules/contracts/src/index.js";

export function ArchiveRestoreSummary(input: {
  archive: ArchiveVersion;
  onRestore(mode: "restore-in-place" | "restore-as-fork"): void;
}) {
  return createElement(
    "section",
    { className: "panel-section" },
    createElement("div", { className: "eyebrow" }, input.archive.id),
    createElement("p", null, input.archive.archiveSummary),
    createElement("p", null, input.archive.workingSummary),
    createElement(
      "div",
      { className: "choice-grid" },
      createElement(
        "button",
        {
          className: "secondary-button",
          type: "button",
          onClick: () => input.onRestore("restore-in-place")
        },
        "Restore in place"
      ),
      createElement(
        "button",
        {
          className: "primary-button",
          type: "button",
          onClick: () => input.onRestore("restore-as-fork")
        },
        "Restore as fork"
      )
    )
  );
}
