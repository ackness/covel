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
  SuspensionSummary,
} from "../session-store/types.js";

const SESSION_ID = "sess-1";
const TURN_ID = "turn-1";
const RUNTIME_ID = "image-gen";
const PLUGIN_ID = "image-gen";
const SUSPENDED_AT = "2026-04-21T10:00:00.000Z";

function makeSuspension(
  overrides: Partial<SuspensionSummary> = {},
): SuspensionSummary {
  return {
    id: "susp-1",
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    runtimeId: RUNTIME_ID,
    pluginId: PLUGIN_ID,
    createdAt: SUSPENDED_AT,
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
        createdAt: SUSPENDED_AT,
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

  it("keeps an accepted detached runtime alive when the foreground execution completes", () => {
    const harness = createHarness({ ...initialState, executing: true });
    harness.handle(
      makeEnvelope("runtime.started", {
        runtimeId: "mimo-tts/auto-narrate",
        pluginId: "mimo-tts",
      }),
    );
    harness.handle(
      makeEnvelope("runtime.deferred", {
        runtimeId: "mimo-tts/auto-narrate",
        pluginId: "mimo-tts",
        jobId: "job-tts-1",
        sourceTurnId: TURN_ID,
      }),
    );
    harness.handle(
      makeEnvelope("execution.completed", {
        committed: true,
      }),
    );

    expect(harness.state().executing).toBe(false);
    expect(harness.state().executionError).toBeNull();
    expect(harness.state().executionSteps).toEqual([
      expect.objectContaining({
        runtimeId: "mimo-tts/auto-narrate",
        pluginId: "mimo-tts",
        status: "deferred",
        detached: true,
        jobId: "job-tts-1",
        turnId: TURN_ID,
      }),
    ]);
  });

  it("updates detached progress and keeps background failure separate from the foreground error", () => {
    const harness = createHarness();
    harness.handle(
      makeEnvelope("runtime.deferred", {
        runtimeId: "mimo-tts/auto-narrate",
        pluginId: "mimo-tts",
        jobId: "job-tts-1",
        sourceTurnId: TURN_ID,
      }),
    );
    harness.handle(
      makeEnvelope("job-status.updated", {
        sessionId: SESSION_ID,
        progressScopeId: "background:job-tts-1",
        runtimeId: "mimo-tts/auto-narrate",
        pluginId: "mimo-tts",
        jobId: "job-tts-1",
        state: "progress",
        progress: 42,
        message: "Synthesizing",
        sequence: 2,
        createdAt: SUSPENDED_AT,
        data: { originTurnId: TURN_ID },
      }),
    );
    expect(harness.state().executionSteps[0]).toEqual(
      expect.objectContaining({
        status: "deferred",
        progress: 42,
        jobState: "progress",
      }),
    );

    harness.handle(
      makeEnvelope("job-status.updated", {
        sessionId: SESSION_ID,
        progressScopeId: "background:job-tts-1",
        runtimeId: "mimo-tts/auto-narrate",
        pluginId: "mimo-tts",
        jobId: "job-tts-1",
        state: "failed",
        sequence: 3,
        createdAt: SUSPENDED_AT,
        data: { originTurnId: TURN_ID, error: "provider unavailable" },
      }),
    );

    expect(harness.state().executionSteps[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        detached: true,
        detail: "provider unavailable",
      }),
    );
    expect(harness.state().executionError).toBeNull();
  });

  it("folds plugin progress sub-jobs into their detached runtime parent", () => {
    const harness = createHarness();
    harness.handle(
      makeEnvelope("runtime.deferred", {
        runtimeId: "mimo-tts/auto-narrate",
        pluginId: "mimo-tts",
        jobId: "runtime-job-1",
        sourceTurnId: TURN_ID,
      }),
    );
    harness.handle(
      makeEnvelope("job-status.updated", {
        sessionId: SESSION_ID,
        progressScopeId: "background-execution-1",
        runtimeId: "mimo-tts/auto-narrate",
        pluginId: "mimo-tts",
        jobId: "provider-sub-job",
        state: "succeeded",
        progress: 80,
        message: "Audio generated; committing metadata",
        sequence: 2,
        createdAt: SUSPENDED_AT,
        data: {
          runtimeJobId: "runtime-job-1",
          originTurnId: TURN_ID,
        },
      }),
    );

    expect(harness.state().executionSteps).toHaveLength(1);
    expect(harness.state().executionSteps[0]).toEqual(
      expect.objectContaining({
        runtimeId: "mimo-tts/auto-narrate",
        status: "deferred",
        jobId: "runtime-job-1",
        jobState: "queued",
        progress: 80,
        detail: "Audio generated; committing metadata",
        turnId: TURN_ID,
      }),
    );
  });

  it("hydrates legacy _jobs rows into session-level background visibility", () => {
    const state = reducer(initialState, {
      type: "REPLACE_PLUGIN_DATA",
      pluginData: {
        "image-gen": {
          _jobs: {
            "job-image-1": {
              status: "pending",
              progress: 12,
              runtimeId: "image-gen/render",
              turnId: "background-turn-1",
              startedAt: SUSPENDED_AT,
            },
          },
        },
      },
    });

    expect(state.executionSteps).toEqual([
      expect.objectContaining({
        runtimeId: "image-gen/render",
        pluginId: "image-gen",
        status: "deferred",
        detached: true,
        jobId: "job-image-1",
        progress: 12,
      }),
    ]);
  });

  it("hydrates durable staged runtime jobs with their source turn", () => {
    const state = reducer(initialState, {
      type: "REPLACE_PLUGIN_DATA",
      pluginData: {
        "mimo-tts": {
          _runtime_jobs: {
            "job-tts-2": {
              schemaVersion: 1,
              jobId: "job-tts-2",
              pluginId: "mimo-tts",
              runtimeId: "mimo-tts/auto-narrate",
              status: "running",
              origin: {
                activation: "stage",
                sourceTurnId: TURN_ID,
              },
              enqueuedAt: SUSPENDED_AT,
              updatedAt: SUSPENDED_AT,
              attempt: 1,
            },
          },
        },
      },
    });

    expect(state.executionSteps).toEqual([
      expect.objectContaining({
        runtimeId: "mimo-tts/auto-narrate",
        pluginId: "mimo-tts",
        turnId: TURN_ID,
        status: "deferred",
        detached: true,
        jobId: "job-tts-2",
        jobState: "running",
      }),
    ]);
  });

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
