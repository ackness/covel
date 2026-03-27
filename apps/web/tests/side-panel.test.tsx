// @vitest-environment jsdom
import React from "react";

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import { SidePanel } from "../src/components/side-panel.js";
import { renderWithI18n } from "./helpers/render-with-i18n.js";

describe("SidePanel", () => {
  it("organizes session, quest, world, and debug data into a tabbed workbench", async () => {
    const user = userEvent.setup();

    renderWithI18n(
      <SidePanel
        selectedWorld={{
          id: "world_01",
          name: "雾港十三号",
          description: "风暴边缘的浮桥城。",
          createdAt: "2026-03-27T12:00:00.000Z"
        }}
        selectedSession={{
          id: "session_01",
          worldId: "world_01",
          status: "active",
          createdAt: "2026-03-27T12:00:01.000Z",
          taskBindings: {
            "story.narration": "default-story"
          }
        }}
        sessions={[
          {
            id: "session_01",
            worldId: "world_01",
            status: "active",
            createdAt: "2026-03-27T12:00:01.000Z",
            taskBindings: {
              "story.narration": "default-story"
            }
          }
        ]}
        packages={[
          {
            name: "core-guide",
            enabled: true
          },
          {
            name: "core-worldbook",
            enabled: true
          }
        ]}
        presets={[
          {
            id: "default-story",
            name: "默认剧情",
            provider: "openaiCompatible",
            model: "qwen3.5-flash",
            enabled: true,
            isDefault: true,
            scope: "global"
          }
        ]}
        activeSessionPresetId="default-story"
        archives={[
          {
            id: "archive_01",
            sessionId: "session_01",
            turnCutoff: 2,
            createdAt: "2026-03-27T12:10:00.000Z"
          }
        ]}
        guideStateRecords={[
          {
            scope: "session",
            ownerId: "session_01",
            packageName: "core-guide",
            collection: "guide_state",
            key: "latest-choice",
            value: {
              topic: "港口纠纷",
              label: "观察周围"
            },
            updatedAt: "2026-03-27T12:05:00.000Z"
          }
        ]}
        workflowSnapshots={[
          {
            runId: "flow_01",
            stepId: "await-choice",
            sessionId: "session_01",
            status: "suspended",
            suspendPayload: {
              blockId: "blk_01"
            },
            updatedAt: "2026-03-27T12:06:00.000Z"
          },
          {
            runId: "flow_01",
            stepId: "resume",
            sessionId: "session_01",
            status: "completed",
            resumeData: {
              selected: "opt_a"
            },
            updatedAt: "2026-03-27T12:08:00.000Z"
          }
        ]}
        traceEntries={[
          {
            traceId: "tr_01",
            spanId: "span_01",
            sessionId: "session_01",
            turnId: "turn_01",
            component: "flow-engine",
            eventType: "workflow.suspended",
            payload: {},
            createdAt: new Date("2026-03-27T12:06:00.000Z")
          }
        ]}
        workspace={{
          timeline: [],
          pendingBlock: {
            id: "blk_01",
            type: "choices",
            version: "1.0",
            meta: {
              package: "core-guide",
              requestId: "req_01",
              traceId: "tr_01",
              sessionId: "session_01",
              turnId: "turn_01"
            },
            interaction: {
              requiresResponse: true,
              responseSchema: "schemas/blocks/choices.response.json",
              submitAs: "block_response",
              resumePolicy: "resume_current_flow"
            },
            data: {
              title: "下一步",
              options: [
                {
                  id: "opt_a",
                  label: "继续前进"
                }
              ]
            }
          },
          lastTraceId: "tr_01",
          recentArtifacts: [
            {
              id: "artifact_01",
              kind: "scene-image",
              title: "雾港街景",
              status: "completed"
            }
          ],
          recentStatePatches: [
            {
              id: "patch_01",
              target: "guide_state",
              summary: "已更新当前目标",
              packageName: "core-guide"
            }
          ],
          workflowRuns: [
            {
              id: "flow_01",
              workflowId: "story-turn",
              status: "suspended",
              currentStep: "await-choice",
              summary: "waiting for player input"
            }
          ]
        }}
        status="idle"
        traceId="tr_01"
        onSessionSelect={() => {}}
        onRestoreArchive={() => {}}
      />
    );

    await user.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByText(/港口纠纷/)).toBeTruthy();
    expect(screen.getAllByText("等待交互").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "会话" }));
    expect(screen.getByText("默认剧情 · qwen3.5-flash")).toBeTruthy();
    expect(screen.getByRole("button", { name: "以分支恢复" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "调试" }));
    expect(screen.getByText("运行时活动")).toBeTruthy();
    expect(screen.getByText("最近追踪")).toBeTruthy();
    expect(screen.getAllByText("flow-engine / workflow.suspended").length).toBeGreaterThan(0);
    expect(screen.getAllByText("flow_01").length).toBe(1);
    expect(screen.getAllByText(/resume/).length).toBeGreaterThan(0);
    expect(screen.getByText(/blk_01/)).toBeTruthy();
  });
});
