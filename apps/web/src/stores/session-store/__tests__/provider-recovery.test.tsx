import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionState } from "../types.js";
import type { useBuildSessionActions } from "../actions.js";
import {
  clearAllStreamingText,
  getStreamingText,
} from "@/stores/streaming-text-store.js";

const captured = vi.hoisted(() => ({
  options: null as Parameters<typeof useBuildSessionActions>[0] | null,
}));
const api = vi.hoisted(() => ({
  getSessionExecution: vi.fn(),
  getSessionView: vi.fn(),
  getSession: vi.fn(),
}));
const workspace = vi.hoisted(() => ({
  hydrate: vi.fn(async () => {}),
  run: vi.fn(),
  checkpoint: vi.fn(),
}));
vi.mock("@/services/api", () => api);
vi.mock("@/services/data-service", () => ({
  getDataService: () => ({}),
  getSessionWorkspace: () => workspace,
  getStorageMode: () => "remote",
}));
// Replace commands/boot only: the provider, refs, reducer, SSE handler and
// recovery hook below are real, so omitted production ref wiring fails here.
vi.mock("../actions.js", () => ({
  useBuildSessionActions: (
    options: Parameters<typeof useBuildSessionActions>[0],
  ) => {
    captured.options = options;
    return {};
  },
}));
vi.mock("../effects.js", () => ({
  useBootEffect: () => {},
  usePersistExecutionStepsEffect: () => {},
  useUiSpecHydrationEffect: () => {},
}));
vi.mock("@/services/subscription.js", () => ({
  createSessionSubscription: () => ({
    on: () => {},
    close: () => {},
    reconnect: () => {},
  }),
}));
const { SessionProvider, useSession } = await import("../../session-store.js");
const session = {
  id: "s",
  worldId: "w",
  phase: "playing" as const,
  completedPlayerTurns: 2,
  status: "active" as const,
  activePlugins: [],
  setupRuntimes: {},
  locale: "en-US",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
let published: SessionState;
function Consumer() {
  published = useSession().state;
  return null;
}
beforeEach(() => {
  vi.clearAllMocks();
  captured.options = null;
});
afterEach(() => {
  clearAllStreamingText();
  vi.restoreAllMocks();
});

it("the production provider passes ownership and delta refs to terminal recovery", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  api.getSessionExecution.mockResolvedValue({
    state: "completed",
    turnId: "turn",
  });
  api.getSession.mockResolvedValue(session);
  api.getSessionView.mockResolvedValue({
    session,
    messages: [
      {
        id: "durable",
        role: "assistant",
        content: "Full committed narrative",
        turnId: "turn",
        runtimeId: "story/main",
        kind: "story",
        createdAt: session.createdAt,
      },
    ],
    execution: { state: "completed", turnId: "turn" },
    executionSteps: [],
    characters: [],
    gameState: {},
  });
  render(
    <SessionProvider>
      <Consumer />
    </SessionProvider>,
  );
  act(() => {
    captured.options!.dispatch({ type: "SET_SESSION", session });
    captured.options!.dispatch({ type: "SET_EXECUTING", value: true });
  });
  const delta = {
    type: "narrative.delta",
    sessionId: "s",
    turnId: "turn",
    requestId: "request",
    traceId: "trace",
    flowId: "flow",
    seq: 1,
    timestamp: session.createdAt,
    payload: {
      kind: "story",
      runtimeId: "story/main",
      pluginId: "story",
      delta: "partial",
    },
  } as const;
  act(() => {
    captured.options!.handleSseEvent(delta);
    for (const callback of [...frames.values()]) callback(0);
  });
  expect(published.messages[0]?.id).toBe("stream_turn_story/main");
  expect(getStreamingText("stream_turn_story/main")).toBe("partial");
  act(() => {
    captured.options!.handleSseEvent({ ...delta, seq: 2 });
    captured.options!.dispatch({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: "s",
        status: null,
        hydrating: false,
        checking: true,
      },
    });
  });
  await waitFor(() =>
    expect(published.messages[0]?.content).toBe("Full committed narrative"),
  );
  expect(published.executing).toBe(false);
  expect(getStreamingText("stream_turn_story/main")).toBeUndefined();
  expect(captured.options!.refs.deltaBufferRef.current.size).toBe(0);
  expect(frames.size).toBe(0);
  expect(workspace.run).not.toHaveBeenCalled();
});
