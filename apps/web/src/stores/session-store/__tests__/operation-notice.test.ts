// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { subscribeToast } from "@/lib/toast-channel.js";
import { initialState } from "../reducer.js";
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
});
