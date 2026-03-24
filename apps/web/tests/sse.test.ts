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
    expect(state.lastTraceId).toBe("tr_02");
  });
});
