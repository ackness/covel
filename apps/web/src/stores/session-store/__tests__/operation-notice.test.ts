import { toFrontendMessage } from "@/services/data-service/mappers.js";
import { toStreamMessages } from "../restore-session.js";
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

        stateRef: { current: { ...initialState } },
        sessionIdRef: { current: "session" },

        lastBackfilledTurnIdRef: { current: null },
      });
      const toast = vi.fn();
      const unsubscribe = subscribeToast(toast);
      try {
        handler({
          type: "operation.failed",
          payload: {
            sessionId: "session",
            turnId: "turn",
            count,
            messages: [],
          },
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

      stateRef: { current: state },
      sessionIdRef: { current: "session" },

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
      [
        "operation.failed",
        { sessionId: "session", turnId: "turn", count: 1, messages: [] },
      ],
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

describe("durable operation failure receipts", () => {
  const row = (
    id: string,
    extra: Partial<import("../types.js").StreamMessage> = {},
  ): import("../types.js").StreamMessage => ({
    id,
    role: "assistant",
    kind: "story",
    turnId: "turn",
    content: "Unchanged story.",
    timestamp: "2026-10-31T00:00:00Z",
    ...extra,
  });
  it("sets counts by durable ID, is idempotent and rejects foreign ownership and malformed counts", () => {
    let state = {
      ...initialState,
      session: { id: "session" } as NonNullable<typeof initialState.session>,
      messages: [
        row("story"),
        row("other-unit"),
        row("old", { turnId: "old-turn" }),
        row("user", { role: "user" }),
        row("system", { role: "system" }),
        row("plugin", { kind: "plugin" }),
        row("unrelated-story", { turnId: "unrelated-turn" }),
      ],
    };
    const handler = createSseEventHandler({
      dispatch: (action) => {
        state = reducer(state, action) as typeof state;
      },

      stateRef: { current: state },
      sessionIdRef: { current: "session" },

      lastBackfilledTurnIdRef: { current: null },
    });
    const send = (messages: unknown[], extra: Record<string, unknown> = {}) =>
      handler({
        type: "operation.failed",
        payload: {
          sessionId: "session",
          turnId: "turn",
          count: 1,
          messages,
          ...extra,
        },
        sessionId: "session",
        turnId: "turn",
        requestId: "request",
        traceId: "trace",
        flowId: "flow",
        seq: 0,
        timestamp: "now",
      } as SseEnvelope);
    const targets = state.messages.map((message) => ({
      messageId: message.id,
      count: 2,
    }));
    send(targets, { sessionId: "foreign" });
    send(targets, { turnId: "foreign-turn" });
    expect(state.messages.every((message) => !message.operationFailures)).toBe(
      true,
    );
    send([{ messageId: "story", count: 1 }]);
    send([{ messageId: "story", count: 1 }]);
    expect(state.messages[0]?.operationFailures).toEqual({ count: 1 });
    for (const count of [
      0,
      -1,
      1.5,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "4",
    ])
      send([{ messageId: "story", count }]);
    send(
      targets.filter(
        (target) =>
          target.messageId !== "other-unit" && target.messageId !== "story",
      ),
    );
    send([{ messageId: "unknown", count: 1 }]);
    expect(state.messages.map((message) => message.operationFailures)).toEqual([
      { count: 1 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(state.messages).toHaveLength(7);
    expect(state.executionError).toBeNull();
    send([{ messageId: "story", count: 3 }]);
    expect(state.messages[0]?.operationFailures).toEqual({ count: 3 });
    expect(state.messages[0]?.content).toBe("Unchanged story.");
  });
});

it("projects only validated notices through local checkpoints and Web restore inputs", () => {
  const record = {
    id: "saved",
    sessionId: "session",
    role: "assistant",
    content: "Story.",
    metadata: {
      kind: "story",
      operationFailures: { count: 2 },
      operations: [{ summary: "PRIVATE-SUMMARY" }],
    },
    createdAt: "now",
  };
  const frontend = toFrontendMessage(record);
  expect(frontend.operationFailures).toEqual({ count: 2 });
  expect(JSON.stringify(frontend)).not.toContain("PRIVATE-SUMMARY");
  expect(toStreamMessages([frontend])[0]?.operationFailures).toEqual({
    count: 2,
  });
  for (const operationFailures of [
    { count: 0 },
    { count: 1.5 },
    { count: 1, summary: "PRIVATE-SUMMARY" },
  ]) {
    expect(
      toFrontendMessage({
        ...record,
        metadata: { ...record.metadata, operationFailures },
      }).operationFailures,
    ).toBeUndefined();
    expect(
      toStreamMessages([{ ...frontend, operationFailures }])[0]
        ?.operationFailures,
    ).toBeUndefined();
  }
});
