import { describe, it, expect } from "vitest";
import { PLAYER_ABORT_REASON } from "@covel/shared";
import type { SseEnvelope } from "@/services/api.js";
import type { SessionState } from "../session-store/types.js";
import { initialState, reducer } from "../session-store/reducer.js";
import { createSseEventHandler } from "../session-store/sse-handler.js";

describe("execution terminal state preserves committed stories", () => {
  it.each([PLAYER_ABORT_REASON, "budget-cap-exceeded", "commit-veto"])(
    "retains history without drafts after %s",
    (reason) => {
      const saved = {
        id: "saved",
        role: "assistant" as const,
        kind: "story" as const,
        content: "Previous story",
        timestamp: "now",
        turnId: "turn-1",
      };
      const stateRef: { current: SessionState } = {
        current: { ...initialState, executing: true, messages: [saved] },
      };
      const handle = createSseEventHandler({
        dispatch: (a) => {
          stateRef.current = reducer(stateRef.current, a);
        },
        stateRef,
        sessionIdRef: { current: "s" },
        lastBackfilledTurnIdRef: { current: "turn-1" },
      });
      const event = (
        type: string,
        payload: Record<string, unknown>,
      ): SseEnvelope => ({
        type,
        sessionId: "s",
        turnId: "turn-1",
        requestId: "r",
        traceId: "t",
        flowId: "f",
        seq: 1,
        timestamp: "now",
        payload,
      });
      handle(
        event("runtime.completed", {
          runtimeId: "narrator",
          pluginId: "fixture",
          output: "SECRET CANDIDATE",
          status: "completed",
        }),
      );
      handle(
        event("execution.completed", {
          committed: reason !== "commit-veto",
          abortReason: reason === "commit-veto" ? undefined : reason,
          error: reason === "commit-veto" ? reason : undefined,
        }),
      );
      expect(stateRef.current.messages).toEqual([saved]);
      expect(stateRef.current.executing).toBe(false);
      expect(stateRef.current).not.toHaveProperty("unsavedNarratives");
      expect(JSON.stringify(stateRef.current)).not.toContain(
        "SECRET CANDIDATE",
      );
      expect(stateRef.current.executionError).toBe(
        reason === PLAYER_ABORT_REASON ? null : reason,
      );
    },
  );
});
