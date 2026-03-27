import React, { createElement } from "react";

import { RuntimeActivityPanel } from "./components/runtime-activity-panel.js";
import { TraceSummary } from "./components/trace-summary.js";
import type { RuntimeArtifactItem, StatePatchEvent, TraceRecord, WorkflowRunItem } from "./types.js";

export interface HostPanelContext {
  artifacts: RuntimeArtifactItem[];
  statePatches: StatePatchEvent[];
  traceEntries: TraceRecord[];
  traceId: string | null;
  workflowRuns: WorkflowRunItem[];
}

export interface HostPanelSpec {
  id: string;
  render(context: HostPanelContext): React.ReactNode;
}

const PANEL_REGISTRY: HostPanelSpec[] = [
  {
    id: "runtime-activity",
    render(context) {
      return createElement(RuntimeActivityPanel, {
        artifacts: context.artifacts,
        statePatches: context.statePatches,
        workflowRuns: context.workflowRuns
      });
    }
  },
  {
    id: "recent-trace",
    render(context) {
      return createElement(TraceSummary, {
        traceId: context.traceId,
        entries: context.traceEntries
      });
    }
  }
];

export function listHostPanels(): HostPanelSpec[] {
  return [...PANEL_REGISTRY];
}
