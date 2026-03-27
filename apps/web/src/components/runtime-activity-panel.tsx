import React, { createElement } from "react";

import { useI18n } from "../i18n.js";
import type { RuntimeArtifactItem, StatePatchEvent, WorkflowRunItem } from "../types.js";

export function RuntimeActivityPanel(input: {
  artifacts: RuntimeArtifactItem[];
  statePatches: StatePatchEvent[];
  workflowRuns: WorkflowRunItem[];
}) {
  const { t } = useI18n();

  return createElement(
    "section",
    { className: "panel-section" },
    createElement("div", { className: "eyebrow" }, t("runtime.activity")),
    createElement("div", { className: "runtime-section-title" }, t("runtime.workflow")),
    createElement(
      "ul",
      { className: "stack-list" },
      ...(input.workflowRuns.length > 0
        ? input.workflowRuns.map((run, index) =>
            renderDetailDisclosure({
              key: run.id,
              open: index === 0,
              title: run.workflowId ?? run.id,
              summary: `${t(`runtime.status.${run.status}`)} · ${run.summary}`,
              body: JSON.stringify({
                currentStep: run.currentStep ?? null,
                traceId: run.traceId ?? null
              }, null, 2)
            })
          )
        : [createElement("li", { key: "workflow-none", className: "empty-copy" }, t("runtime.noWorkflow"))])
    ),
    createElement("div", { className: "runtime-section-title" }, t("runtime.statePatch")),
    createElement(
      "ul",
      { className: "stack-list" },
      ...(input.statePatches.length > 0
        ? input.statePatches.map((patch, index) =>
            renderDetailDisclosure({
              key: patch.id,
              open: index === 0,
              title: patch.summary,
              summary: patch.scopeLabel ?? patch.target,
              body: JSON.stringify({
                packageName: patch.packageName ?? null,
                traceId: patch.traceId ?? null
              }, null, 2)
            })
          )
        : [createElement("li", { key: "state-none", className: "empty-copy" }, t("runtime.noStatePatch"))])
    ),
    createElement("div", { className: "runtime-section-title" }, t("runtime.artifacts")),
    createElement(
      "ul",
      { className: "stack-list" },
      ...(input.artifacts.length > 0
        ? input.artifacts.map((artifact, index) =>
            renderDetailDisclosure({
              key: artifact.id,
              open: index === 0,
              title: artifact.title ?? artifact.kind,
              summary: artifact.status ?? artifact.mediaType ?? artifact.uri ?? artifact.id,
              body: JSON.stringify({
                kind: artifact.kind,
                traceId: artifact.traceId ?? null,
                uri: artifact.uri ?? null
              }, null, 2)
            })
          )
        : [createElement("li", { key: "artifact-none", className: "empty-copy" }, t("runtime.noArtifact"))])
    )
  );
}

function renderDetailDisclosure(input: {
  body: string;
  key: string;
  open: boolean;
  summary: string;
  title: string;
}) {
  return createElement(
    "li",
    { key: input.key },
    createElement(
      "details",
      {
        className: "detail-disclosure",
        open: input.open ? true : undefined
      },
      createElement(
        "summary",
        { className: "detail-summary" },
        createElement("span", null, input.title),
        createElement("span", { className: "workspace-meta" }, input.summary)
      ),
      createElement(
        "div",
        { className: "detail-body" },
        createElement("pre", { className: "payload-preview" }, input.body)
      )
    )
  );
}
