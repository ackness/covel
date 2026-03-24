import React, { createElement } from "react";

import type { ArchiveVersion } from "../../../../modules/contracts/src/index.js";
import { useI18n } from "../i18n.js";

export function ArchiveRestoreSummary(input: {
  archive: ArchiveVersion;
  onRestore(mode: "restore-in-place" | "restore-as-fork"): void;
}) {
  const { t } = useI18n();

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
        t("archive.restoreInPlace")
      ),
      createElement(
        "button",
        {
          className: "primary-button",
          type: "button",
          onClick: () => input.onRestore("restore-as-fork")
        },
        t("archive.restoreAsFork")
      )
    )
  );
}
