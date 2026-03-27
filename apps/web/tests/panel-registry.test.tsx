// @vitest-environment jsdom
import React from "react";

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { listHostPanels } from "../src/panel-registry.js";
import { renderWithI18n } from "./helpers/render-with-i18n.js";

describe("host panel registry", () => {
  it("renders runtime activity and trace panels from the host registry", () => {
    const panels = listHostPanels();

    renderWithI18n(
      <>
        {panels.map((panel) => (
          <React.Fragment key={panel.id}>
            {panel.render({
              artifacts: [
                {
                  id: "artifact_01",
                  kind: "scene-image",
                  title: "雾港街景",
                  status: "completed",
                  traceId: "tr_01"
                }
              ],
              statePatches: [
                {
                  id: "patch_01",
                  target: "guide_state",
                  summary: "已更新当前目标",
                  packageName: "core-guide",
                  traceId: "tr_01"
                }
              ],
              traceEntries: [
                {
                  traceId: "tr_01",
                  spanId: "span_01",
                  sessionId: "session_01",
                  turnId: "turn_01",
                  component: "flow-engine",
                  eventType: "workflow.suspended",
                  payload: {
                    reason: "waiting for input"
                  },
                  createdAt: new Date("2026-03-27T12:10:00.000Z")
                }
              ],
              traceId: "tr_01",
              workflowRuns: [
                {
                  id: "flow_01",
                  workflowId: "story-turn",
                  status: "suspended",
                  currentStep: "await-choice",
                  summary: "waiting for input",
                  traceId: "tr_01"
                }
              ]
            })}
          </React.Fragment>
        ))}
      </>
    );

    expect(screen.getByText("运行时活动")).toBeTruthy();
    expect(screen.getByText("最近追踪")).toBeTruthy();
    expect(screen.getAllByText("story-turn").length).toBeGreaterThan(0);
    expect(screen.getAllByText("雾港街景").length).toBeGreaterThan(0);
    expect(screen.getAllByText("flow-engine / workflow.suspended").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/waiting for input/).length).toBeGreaterThan(0);
    expect(screen.getByText("span_01")).toBeTruthy();
  });
});
