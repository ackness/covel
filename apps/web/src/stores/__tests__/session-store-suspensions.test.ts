/**
 * Regression coverage for suspension state through the production reducer and
 * action-stream handler. The same events can arrive on the action stream and
 * the persistent subscription, so reducer-level dedupe remains essential.
 */

import { describe, expect, it } from "vitest";
import type { SseEnvelope } from "@/services/api";
import { initialState, reducer } from "../session-store/reducer.js";
import {
  applyResumeEvents,
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../session-store/sse-handler.js";
import type {
  SessionAction,
  SessionState,
  SuspensionRecord,
} from "../session-store/types.js";

const SESSION_ID = "sess-1";
const TURN_ID = "turn-1";
const RUNTIME_ID = "image-gen";
const PLUGIN_ID = "image-gen";
const SUSPENDED_AT = "2026-04-21T10:00:00.000Z";

function makeSuspension(
  overrides: Partial<SuspensionRecord> = {},
): SuspensionRecord {
  return {
    id: "susp-1",
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    runtimeId: RUNTIME_ID,
    pluginId: PLUGIN_ID,
    suspendedAt: SUSPENDED_AT,
    reason: "Waiting for fal.ai job",
    resumeSchema: { type: "object" },
    ...overrides,
  };
}

function makeEnvelope(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<SseEnvelope> = {},
): SseEnvelope {
  return {
    type,
    requestId: "req-1",
    traceId: "trace-1",
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    flowId: "trace-1",
    seq: 1,
    timestamp: SUSPENDED_AT,
    payload,
    ...overrides,
  };
}

function createHarness(seed: SessionState = initialState): {
  readonly handle: ReturnType<typeof createSseEventHandler>;
  readonly state: () => SessionState;
} {
  let current = seed;
  const stateRef = { current };
  const dispatch = (action: SessionAction): void => {
    current = reducer(current, action);
    stateRef.current = current;
  };
  const deps: SseEventHandlerDeps = {
    dispatch,
    ds: {} as SseEventHandlerDeps["ds"],
    sessionIdRef: { current: SESSION_ID },
    stateRef,
    runtimeKindRef: { current: new Map() },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  };
  return { handle: createSseEventHandler(deps), state: () => current };
}

describe("session-store — suspensions", () => {
  it("hydrates and removes the server suspension list through the real reducer", () => {
    const keep = makeSuspension({ id: "keep" });
    const drop = makeSuspension({ id: "drop" });
    let state = reducer(initialState, {
      type: "SET_SUSPENSIONS",
      suspensions: [keep, drop],
    });

    state = reducer(state, { type: "REMOVE_SUSPENSION", suspensionId: "drop" });
    expect(state.suspensions).toEqual([keep]);

    expect(
      reducer(state, { type: "REMOVE_SUSPENSION", suspensionId: "missing" })
        .suspensions,
    ).toEqual([keep]);
  });

  it("dedupes the same turn.suspended envelope through the real handler and reducer", () => {
    const harness = createHarness();
    const suspension = makeSuspension({ id: "dup" });
    const event = makeEnvelope("turn.suspended", {
      suspensionId: suspension.id,
      runtimeId: suspension.runtimeId,
      pluginId: suspension.pluginId,
      reason: suspension.reason,
      resumeSchema: suspension.resumeSchema,
    });

    harness.handle(event);
    const once = harness.state();
    harness.handle(event);

    expect(harness.state()).toBe(once);
    expect(harness.state().suspensions).toEqual([
      expect.objectContaining({
        ...suspension,
        suspendedAt: SUSPENDED_AT,
      }),
    ]);
  });

  it.each([
    ["suspended", "suspended"],
    ["failed", "failed"],
    ["skipped", "skipped"],
    ["completed", "completed"],
    [undefined, "completed"],
  ] as const)(
    "maps runtime.completed status %s through the production SSE handler",
    (rawStatus, expectedStatus) => {
      const harness = createHarness();
      harness.handle(
        makeEnvelope("runtime.started", {
          runtimeId: RUNTIME_ID,
          pluginId: PLUGIN_ID,
          label: "image-gen/plugin",
        }),
      );
      harness.handle(
        makeEnvelope("runtime.completed", {
          runtimeId: RUNTIME_ID,
          pluginId: PLUGIN_ID,
          ...(rawStatus ? { status: rawStatus } : {}),
          durationMs: 42,
        }),
      );

      expect(harness.state().executionSteps).toEqual([
        expect.objectContaining({
          runtimeId: RUNTIME_ID,
          pluginId: PLUGIN_ID,
          status: expectedStatus,
          durationMs: 42,
          turnId: TURN_ID,
          label: "image-gen/plugin",
        }),
      ]);
    },
  );

  it("replays resumed events through the production handler and resolves the suspended runtime", () => {
    const harness = createHarness();
    harness.handle(
      makeEnvelope("turn.suspended", {
        suspensionId: "img-1",
        runtimeId: RUNTIME_ID,
        pluginId: PLUGIN_ID,
      }),
    );
    harness.handle(
      makeEnvelope("runtime.completed", {
        runtimeId: RUNTIME_ID,
        pluginId: PLUGIN_ID,
        status: "suspended",
      }),
    );

    applyResumeEvents(
      [
        {
          id: "event-narrative",
          type: "narrative.completed",
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          timestamp: "2026-04-22T10:00:01.000Z",
          source: { pluginId: PLUGIN_ID, runtimeId: RUNTIME_ID },
          payload: {
            content: "Image generation resumed successfully.",
            kind: "story",
            messageId: "msg-1",
          },
        },
        {
          id: "event-interaction",
          type: "interaction.requested",
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          timestamp: "2026-04-22T10:00:02.000Z",
          source: { pluginId: PLUGIN_ID, runtimeId: RUNTIME_ID },
          payload: {
            block: {
              id: "block-1",
              type: "ui-spec",
              data: { title: "Generated image" },
            },
          },
        },
        {
          id: "event-resumed",
          type: "turn.resumed",
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          timestamp: "2026-04-22T10:00:03.000Z",
          source: { pluginId: PLUGIN_ID, runtimeId: RUNTIME_ID },
          payload: {
            suspensionId: "img-1",
            runtimeId: RUNTIME_ID,
            pluginId: PLUGIN_ID,
            status: "success",
            durationMs: 84,
          },
        },
      ],
      harness.handle,
    );

    expect(harness.state().suspensions).toEqual([]);
    expect(harness.state().executionSteps).toEqual([
      expect.objectContaining({
        runtimeId: RUNTIME_ID,
        pluginId: PLUGIN_ID,
        status: "completed",
        durationMs: 84,
        turnId: TURN_ID,
      }),
    ]);
    expect(harness.state().messages).toEqual([
      expect.objectContaining({
        id: "msg-1",
        content: "Image generation resumed successfully.",
        runtimeId: RUNTIME_ID,
      }),
      expect.objectContaining({
        id: "block-1",
        content: "",
        runtimeId: RUNTIME_ID,
        block: expect.objectContaining({ type: "ui-spec" }),
      }),
    ]);
  });
});
