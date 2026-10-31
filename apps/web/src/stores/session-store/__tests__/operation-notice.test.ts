// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { subscribeToast } from "@/lib/toast-channel.js";
import type { SseEnvelope } from "@/services/api.js";
import { initialState, reducer } from "../reducer.js";
import type { SessionAction } from "../types.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../sse-handler.js";

describe("operation failure notice", () => {
  it.each([
    ["en-US", 1, "1 action from this turn did not take effect."],
    ["en-US", 2, "2 actions from this turn did not take effect."],
    ["zh-CN", 2, "本回合有 2 个操作没有生效。"],
  ] as const)(
    "shows one fixed toast in %s for %i operations",
    async (locale, count, message) => {
      await i18n.changeLanguage(locale);
      const dispatch = vi.fn();
      const handler = createSseEventHandler({
        dispatch,
        ds: {} as SseEventHandlerDeps["ds"],
        stateRef: { current: { ...initialState } },
        sessionIdRef: { current: "session" },
        deltaBufferRef: { current: new Map() },
        deltaRafRef: { current: null },
        lastBackfilledTurnIdRef: { current: null },
      });
      const toast = vi.fn();
      const unsubscribe = subscribeToast(toast);
      try {
        handler({
          type: "operation.failed",
          payload: { sessionId: "session", turnId: "turn", count },
          sessionId: "session",
          turnId: "turn",
          requestId: "request",
          traceId: "trace",
          flowId: "flow",
          seq: 0,
          timestamp: "2026-10-31T00:00:00Z",
        });
        expect(toast).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ kind: "info", message }),
        );
        expect(dispatch).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "SET_EXECUTION_ERROR" }),
        );
      } finally {
        unsubscribe();
      }
    },
  );

  it("leaves a committed turn with one isolated operation failure without an execution error", async () => {
    await i18n.changeLanguage("en-US");
    let state = { ...initialState, executing: true } as typeof initialState;
    const handler = createSseEventHandler({
      dispatch: (action: SessionAction) => {
        state = reducer(state, action);
      },
      ds: {} as SseEventHandlerDeps["ds"],
      stateRef: { current: state },
      sessionIdRef: { current: "session" },
      deltaBufferRef: { current: new Map() },
      deltaRafRef: { current: null },
      lastBackfilledTurnIdRef: { current: null },
    });
    const toast = vi.fn();
    const unsubscribe = subscribeToast(toast);
    const story = { runtimeId: "narrator", pluginId: "narrator", runId: "run" };
    // The action stream of a story turn whose second write-service call was
    // rejected at commit: the story commits, the operation alone is dropped.
    const sequence: Array<[string, Record<string, unknown>]> = [
      ["execution.started", { status: "executing", runtimeCount: 1 }],
      ["runtime.started", { ...story, stage: "narrative", kind: "story" }],
      [
        "subagent.started",
        {
          pluginId: "cast",
          runtimeId: "cast/actor",
          parentCallId: "delegate-one",
          subagentCallId: "child-one",
        },
      ],
      [
        "subagent.completed",
        {
          pluginId: "cast",
          runtimeId: "cast/actor",
          parentCallId: "delegate-one",
          subagentCallId: "child-one",
        },
      ],
      [
        "subagent.failed",
        {
          pluginId: "cast",
          runtimeId: "cast/actor",
          parentCallId: "delegate-two",
          subagentCallId: "child-two",
          code: "unavailable",
          error: "Finish without further children",
        },
      ],
      ["tool.completed", { ...story, toolName: "change", success: true }],
      ["tool.completed", { ...story, toolName: "change", success: true }],
      ["runtime.completed", { ...story, status: "success" }],
      ["operation.failed", { sessionId: "session", turnId: "turn", count: 1 }],
      ["execution.completed", { committed: true }],
    ];
    try {
      sequence.forEach(([type, payload], seq) =>
        handler({
          type,
          payload,
          sessionId: "session",
          turnId: "turn",
          requestId: "request",
          traceId: "trace",
          flowId: "flow",
          seq,
          timestamp: "2026-10-31T00:00:00Z",
        } as SseEnvelope),
      );
      expect(toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind: "info",
          message: "1 action from this turn did not take effect.",
        }),
      );
      expect(state.executionError).toBeNull();
      expect(state.executing).toBe(false);
      expect(
        state.executionSteps.find((step) => step.runtimeId === "narrator"),
      ).toMatchObject({ status: "completed", attemptStatus: "committed" });
    } finally {
      unsubscribe();
    }
  });
});
