// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  CovelEvent,
  SseEnvelope,
  StoryMessageSegment,
} from "@covel/shared";
import i18n from "@/i18n";
import { subscribeToast } from "@/lib/toast-channel.js";
import { initialState, reducer } from "../reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../sse-handler.js";

// Mirrors the ordered settlement events asserted by the server's
// tests/api/bundled-actor-settlement.test.ts; model/step/hook traces are omitted.
function settlementEvents(
  mode: "actor-failure" | "commit-rejection",
): CovelEvent[] {
  const planner = {
    pluginId: "chat-mode-narrator",
    runtimeId: "chat-mode-narrator/plan",
  };
  const narrator = {
    pluginId: "chat-mode-narrator",
    runtimeId: "chat-mode-narrator/narrate",
  };
  const actor = {
    pluginId: "replacement-actor",
    runtimeId: "replacement-actor",
  };
  const segments: StoryMessageSegment[] = [
    {
      kind: "dialogue",
      speaker: "Mara",
      speakerId: "character-Mara",
      text: "Mara answers.",
    },
    ...(mode === "commit-rejection"
      ? [
          {
            kind: "dialogue" as const,
            speaker: "Ivo",
            speakerId: "character-Ivo",
            text: "Ivo answers.",
          },
        ]
      : []),
    { kind: "narration", text: "The bell grows quiet." },
  ];
  const completed = {
    runtimeCount: 3,
    resultCount: 2,
    durationMs: 0,
    committed: true,
  };
  const round = {
    requestId: "request",
    rootId: "root",
    turnId: "turn",
    round: 0,
    limit: 3,
  };
  const sequence: CovelEvent[] = [
    {
      type: "execution.started",
      payload: { status: "executing", runtimeCount: 3 },
    },
    {
      type: "runtime.started",
      payload: { ...planner, stage: "pre-turn", kind: "system" },
    },
    { type: "runtime.completed", payload: { ...planner, status: "success" } },
    {
      type: "runtime.started",
      payload: { ...narrator, stage: "narrative", kind: "story" },
    },
    {
      type: "tool.completed",
      payload: {
        ...actor,
        toolName: "change",
        toolCallId: "change-Mara",
        success: true,
      },
    },
    {
      type: "tool.completed",
      payload: {
        ...narrator,
        toolName: "delegate",
        toolCallId: "delegate-Mara",
        success: true,
      },
    },
    {
      type: "tool.completed",
      payload: {
        ...actor,
        toolName: "change",
        toolCallId: "change-Ivo",
        success: true,
      },
    },
    {
      type: mode === "actor-failure" ? "tool.failed" : "tool.completed",
      payload: {
        ...narrator,
        toolName: "delegate",
        toolCallId: "delegate-Ivo",
        success: mode !== "actor-failure",
      },
    },
    { type: "runtime.completed", payload: { ...narrator, status: "success" } },
    {
      type: "plugin-data.changed",
      payload: {
        pluginId: "actor-ledger",
        changes: [
          {
            namespace: "items",
            key: "Mara",
            value: { owned: true },
            operation: "set",
          },
        ],
      },
    },
    {
      type: "plugin-data.changed",
      payload: {
        pluginId: "actor-ledger",
        changes: [
          {
            namespace: "receipts",
            key: "Mara",
            value: { accepted: true },
            operation: "set",
          },
        ],
      },
    },
    {
      type: "narrative.completed",
      payload: {
        runtimeId: narrator.runtimeId,
        kind: "story",
        messageId: "story",
        content: segments.map(({ text }) => text).join("\n\n"),
        segments,
      },
    },
  ];
  if (mode === "commit-rejection")
    sequence.push({
      type: "operation.failed",
      payload: { sessionId: "scene", turnId: "turn", count: 1 },
    });
  sequence.push(
    { type: "ui.slot.cleared", payload: { turnId: "turn" } },
    { type: "execution.round.completed", payload: { ...completed, ...round } },
    {
      type: "execution.advance",
      payload: { ...round, phase: "stopped", reason: "yielded-to-player" },
    },
    { type: "execution.completed", payload: completed },
  );
  return sequence;
}

describe("bundled dialogue actor settlement notices", () => {
  it.each(["actor-failure", "commit-rejection"] as const)(
    "keeps the committed story without an execution error after %s",
    async (mode) => {
      await i18n.changeLanguage("en-US");
      const stateRef = { current: { ...initialState, executing: true } };
      const handle = createSseEventHandler({
        dispatch: (action) => {
          stateRef.current = reducer(stateRef.current, action);
        },
        ds: {} as SseEventHandlerDeps["ds"],
        stateRef,
        sessionIdRef: { current: "scene" },
        deltaBufferRef: { current: new Map() },
        deltaRafRef: { current: null },
        lastBackfilledTurnIdRef: { current: null },
      });
      const toast = vi.fn();
      const unsubscribe = subscribeToast(toast);
      try {
        const events: SseEnvelope[] = settlementEvents(mode).map(
          (event, seq) => ({
            ...event,
            payload: { ...event.payload },
            sessionId: "scene",
            turnId: "turn",
            requestId: "request",
            traceId: "trace",
            flowId: "trace",
            seq,
            timestamp: "2026-10-31T00:00:00.000Z",
          }),
        );
        for (const event of events) handle(event);
        if (mode === "commit-rejection")
          expect(toast).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              kind: "info",
              message: "1 action from this turn did not take effect.",
            }),
          );
        else expect(toast).not.toHaveBeenCalled();
        expect(stateRef.current.executionError).toBeNull();
        expect(stateRef.current.executing).toBe(false);
        expect(
          stateRef.current.executionSteps.find(
            (step) => step.runtimeId === "chat-mode-narrator/narrate",
          ),
        ).toMatchObject({ status: "completed", attemptStatus: "committed" });
        expect(stateRef.current.messages).toContainEqual(
          expect.objectContaining({
            id: "story",
            kind: "story",
            content:
              mode === "commit-rejection"
                ? "Mara answers.\n\nIvo answers.\n\nThe bell grows quiet."
                : "Mara answers.\n\nThe bell grows quiet.",
          }),
        );
      } finally {
        unsubscribe();
      }
    },
  );
});
