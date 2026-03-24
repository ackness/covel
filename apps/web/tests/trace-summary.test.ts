// @vitest-environment jsdom

import React, { type ComponentType, createElement } from "react";
import {
  cleanup,
  render,
  screen
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TraceRecord } from "../../../modules/contracts/src/index.js";
import { loadWebModule } from "./helpers/load-web-module.js";
import { renderWithI18n } from "./helpers/render-with-i18n.js";

interface TraceSummaryProps {
  traceId: string | null;
  entries: TraceRecord[];
}

interface TraceSummaryModule {
  TraceSummary: ComponentType<TraceSummaryProps>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("apps/web TraceSummary", () => {
  it("renders the latest trace id with a component/eventType summary list", async () => {
    const { TraceSummary } = await loadWebModule<TraceSummaryModule>("components/trace-summary.ts");

    renderWithI18n(createElement(TraceSummary, {
      traceId: "trace_req_03",
      entries: [
        {
          traceId: "trace_req_03",
          spanId: "span_flow_03",
          sessionId: "session_03",
          turnId: "turn_03",
          component: "flow-engine",
          eventType: "flow.started",
          payload: {
            flowId: "flow_03"
          },
          createdAt: "2026-03-24T12:10:00.000Z"
        },
        {
          traceId: "trace_req_03",
          spanId: "span_model_03",
          sessionId: "session_03",
          turnId: "turn_03",
          component: "model-gateway",
          eventType: "model.completed",
          payload: {
            model: "qwen-plus"
          },
          createdAt: "2026-03-24T12:10:01.000Z"
        }
      ]
    }));

    expect(screen.getByText("最近追踪")).toBeTruthy();
    expect(screen.getByText("trace_req_03")).toBeTruthy();
    expect(screen.getByText("flow-engine / flow.started")).toBeTruthy();
    expect(screen.getByText("model-gateway / model.completed")).toBeTruthy();
  });
});
