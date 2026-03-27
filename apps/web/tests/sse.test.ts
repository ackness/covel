import { describe, expect, it } from "vitest";

import { applySseEvent, createInitialWorkspaceState } from "../src/state.js";

describe("applySseEvent", () => {
  it("accumulates message deltas and finalizes completed messages", () => {
    let state = createInitialWorkspaceState();

    state = applySseEvent(state, {
      type: "message.delta",
      requestId: "req_01",
      traceId: "tr_01",
      sessionId: "session_01",
      turnId: "turn_01",
      flowId: "flow_01",
      seq: 1,
      timestamp: "2026-03-24T12:00:00.000Z",
      payload: {
        messageId: "msg_01",
        delta: "North"
      }
    });
    state = applySseEvent(state, {
      type: "message.delta",
      requestId: "req_01",
      traceId: "tr_01",
      sessionId: "session_01",
      turnId: "turn_01",
      flowId: "flow_01",
      seq: 2,
      timestamp: "2026-03-24T12:00:01.000Z",
      payload: {
        messageId: "msg_01",
        delta: "reach"
      }
    });
    state = applySseEvent(state, {
      type: "message.completed",
      requestId: "req_01",
      traceId: "tr_01",
      sessionId: "session_01",
      turnId: "turn_01",
      flowId: "flow_01",
      seq: 3,
      timestamp: "2026-03-24T12:00:02.000Z",
      payload: {
        messageId: "msg_01",
        content: "Northreach"
      }
    });

    expect(state.timeline).toEqual([
      {
        kind: "message",
        id: "msg_01",
        role: "assistant",
        content: "Northreach",
        streaming: false
      }
    ]);
  });

  it("captures pending interactive blocks and flow status", () => {
    const state = applySseEvent(createInitialWorkspaceState(), {
      type: "block.emitted",
      requestId: "req_02",
      traceId: "tr_02",
      sessionId: "session_01",
      turnId: "turn_02",
      flowId: "flow_02",
      seq: 1,
      timestamp: "2026-03-24T12:00:00.000Z",
      payload: {
        block: {
          id: "blk_01",
          type: "choices",
          version: "1.0",
          meta: {
            package: "core-guide",
            requestId: "req_02",
            traceId: "tr_02",
            sessionId: "session_01",
            turnId: "turn_02"
          },
          interaction: {
            requiresResponse: true,
            responseSchema: "schemas/blocks/choices.response.json",
            submitAs: "block_response",
            resumePolicy: "resume_current_flow"
          },
          data: {
            title: "Next step",
            options: [
              {
                id: "opt_a",
                label: "Continue"
              }
            ]
          }
        }
      }
    });

    expect(state.pendingBlock?.id).toBe("blk_01");
    expect(state.timeline).toContainEqual(
      expect.objectContaining({
        id: "blk_01",
        kind: "block",
        pending: true
      })
    );
    expect(state.lastTraceId).toBe("tr_02");
  });

  it("tracks workflow, state patch, and artifact updates as typed runtime activity", () => {
    let state = createInitialWorkspaceState();

    state = applySseEvent(state, {
      type: "workflow.suspended",
      requestId: "req_03",
      traceId: "tr_03",
      sessionId: "session_01",
      turnId: "turn_03",
      flowId: "flow_03",
      seq: 1,
      timestamp: "2026-03-24T12:00:00.000Z",
      payload: {
        runId: "workflow_01",
        workflowId: "story-turn",
        currentStep: "await-choice",
        reason: "waiting for player input"
      }
    } as any);
    state = applySseEvent(state, {
      type: "state.patch.applied",
      requestId: "req_03",
      traceId: "tr_03",
      sessionId: "session_01",
      turnId: "turn_03",
      flowId: "flow_03",
      seq: 2,
      timestamp: "2026-03-24T12:00:01.000Z",
      payload: {
        patch: {
          id: "patch_01",
          packageName: "core-guide",
          target: "quest-state",
          summary: "Quest advanced",
          scope: {
            sessionId: "session_01"
          }
        }
      }
    } as any);
    state = applySseEvent(state, {
      type: "artifact.updated",
      requestId: "req_03",
      traceId: "tr_03",
      sessionId: "session_01",
      turnId: "turn_03",
      flowId: "flow_03",
      seq: 3,
      timestamp: "2026-03-24T12:00:02.000Z",
      payload: {
        artifact: {
          id: "artifact_01",
          kind: "scene-image",
          title: "Northreach",
          uri: "artifacts/northreach.png",
          mediaType: "image/png",
          status: "completed"
        }
      }
    } as any);
    state = applySseEvent(state, {
      type: "flow.completed",
      requestId: "req_03",
      traceId: "tr_03",
      sessionId: "session_01",
      turnId: "turn_03",
      flowId: "workflow_01",
      seq: 4,
      timestamp: "2026-03-24T12:00:03.000Z",
      payload: {
        turnId: "turn_03"
      }
    } as any);

    expect(state.workflowRuns).toEqual([
      expect.objectContaining({
        id: "workflow_01",
        workflowId: "story-turn",
        status: "completed",
        currentStep: "await-choice"
      })
    ]);
    expect(state.recentStatePatches).toEqual([
      expect.objectContaining({
        id: "patch_01",
        packageName: "core-guide",
        target: "quest-state",
        summary: "Quest advanced"
      })
    ]);
    expect(state.recentArtifacts).toEqual([
      expect.objectContaining({
        id: "artifact_01",
        kind: "scene-image",
        title: "Northreach",
        status: "completed"
      })
    ]);
  });
});
