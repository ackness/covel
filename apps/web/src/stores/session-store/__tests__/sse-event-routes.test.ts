// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { COVEL_EVENT_META, type CovelEventType } from "@covel/shared";
import type { SseEnvelope } from "@/services/api.js";
import { initialState } from "../reducer.js";
import { SSE_EVENT_ROUTES, isRoutedEventType } from "../sse-event-routes.js";
import { createSseEventHandler } from "../sse-handler.js";
import type { SessionAction } from "../types.js";

const PROTOCOL_EVENT_TYPES = Object.keys(COVEL_EVENT_META) as CovelEventType[];

function harness() {
  const actions: SessionAction[] = [];
  const handle = createSseEventHandler({
    dispatch: (action) => actions.push(action),
    sessionIdRef: { current: "session" },
    stateRef: { current: initialState },
    lastBackfilledTurnIdRef: { current: null },
  });
  const send = (type: string) =>
    handle({
      type,
      requestId: "request",
      traceId: "trace",
      sessionId: "session",
      turnId: "turn",
      flowId: "flow",
      seq: 1,
      timestamp: "2026-11-09T00:00:00Z",
      payload: {},
    } satisfies SseEnvelope);
  return { actions, send };
}

describe("SSE event route table", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes every protocol event type and nothing else", () => {
    expect(Object.keys(SSE_EVENT_ROUTES).sort()).toEqual(
      [...PROTOCOL_EVENT_TYPES].sort(),
    );
    for (const type of PROTOCOL_EVENT_TYPES) {
      const route: unknown = SSE_EVENT_ROUTES[type];
      expect(
        route === "ignored" || typeof route === "function",
        `route for ${type}`,
      ).toBe(true);
    }
  });

  it("does nothing for explicitly ignored events", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ignored = PROTOCOL_EVENT_TYPES.filter(
      (type) => SSE_EVENT_ROUTES[type] === "ignored",
    );
    expect(ignored.length).toBeGreaterThan(0);
    const { actions, send } = harness();
    for (const type of ignored) send(type);
    expect(actions).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["not.a.protocol.event", "constructor", "toString", "__proto__"])(
    "warns about the unknown wire type %s without dispatching",
    (type) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(isRoutedEventType(type)).toBe(false);
      const { actions, send } = harness();
      send(type);
      expect(actions).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        `[sse-handler] unhandled SSE event type: ${type}`,
      );
    },
  );
});
