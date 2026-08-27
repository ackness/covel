import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SseEnvelope } from "@/services/api";
import {
  __clearDomainEventPreviewsForTest,
  getDomainEventPreview,
} from "../domain-event-preview-store.js";
import { initialState } from "../session-store/reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../session-store/sse-handler.js";

const SESSION_ID = "sess-preview";
const TURN_ID = "turn-preview";

function makeDeps(): SseEventHandlerDeps {
  return {
    dispatch: vi.fn(),
    ds: {} as SseEventHandlerDeps["ds"],
    sessionIdRef: { current: SESSION_ID },
    stateRef: { current: initialState },
    runtimeKindRef: { current: new Map() },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  };
}

function envelope(type: string, payload: Record<string, unknown>): SseEnvelope {
  return {
    type,
    requestId: "req-preview",
    traceId: TURN_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    flowId: TURN_ID,
    seq: 1,
    timestamp: "2026-08-27T00:00:00Z",
    payload,
  };
}

describe("sse-handler domain event previews", () => {
  beforeEach(() => __clearDomainEventPreviewsForTest());

  it("publishes a validated domain event to the presentation store", () => {
    const handle = createSseEventHandler(makeDeps());
    handle(
      envelope("domain-event.previewed", {
        runtimeId: "chat-mode-narrator",
        pluginId: "chat-mode-narrator",
        toolCallId: "call-1",
        topic: "stage.direction",
        data: { cues: [{ type: "stage.clear" }] },
      }),
    );

    expect(getDomainEventPreview(SESSION_ID, "stage.direction")).toMatchObject({
      turnId: TURN_ID,
      runtimeId: "chat-mode-narrator",
      topic: "stage.direction",
      data: { cues: [{ type: "stage.clear" }] },
    });
  });

  it("clears speculative state at the execution terminal event", () => {
    const handle = createSseEventHandler(makeDeps());
    handle(
      envelope("domain-event.previewed", {
        topic: "stage.direction",
        data: { cues: [{ type: "stage.clear" }] },
      }),
    );
    handle(
      envelope("execution.completed", {
        runtimeCount: 1,
        resultCount: 1,
        durationMs: 10,
        committed: true,
      }),
    );

    expect(
      getDomainEventPreview(SESSION_ID, "stage.direction"),
    ).toBeUndefined();
  });
});
