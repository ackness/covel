import { useReducer, useRef } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../types.js";
import { initialState, reducer } from "../reducer.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";
import { createSseEventHandler } from "../sse-handler.js";
import {
  getStreamingText,
  clearAllStreamingText,
} from "@/stores/streaming-text-store.js";
import type { DataService } from "@/services/data-service.js";

const api = vi.hoisted(() => ({
  getSessionExecution: vi.fn(),
  getSessionView: vi.fn(),
  getSession: vi.fn(),
  listMessagesPage: vi.fn(),
}));
vi.mock("@/services/api.js", () => api);
const { useExecutionRecovery } = await import("../execution-recovery.js");
const workspace = {
  hydrate: vi.fn(async () => {}),
  run: vi.fn(),
  checkpoint: vi.fn(async () => {}),
};
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
function snapshot(state: "running" | "completed") {
  return {
    session,
    execution: { state, turnId: "t" },
    messages:
      state === "completed"
        ? [
            {
              id: "m",
              role: "assistant",
              content: "Recovered prose",
              turnId: "t",
              kind: "story",
              runtimeId: "story/main",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ]
        : [],
    executionSteps: [
      {
        type: state === "completed" ? "runtime.completed" : "runtime.started",
        turnId: "t",
        timestamp: "2026-01-01T00:00:00Z",
        payload: {
          runtimeId: "story",
          pluginId: "story",
          status: state === "completed" ? "success" : "running",
        },
      },
    ],
    characters: [],
    gameState: {},
  };
}
function setup(overrides: Partial<SessionState> = {}) {
  return renderHook(() => {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      session,
      executing: true,
      executionRecovery: {
        sessionId: "s",
        status: { state: "running", turnId: "t" },
        hydrating: false,
        checking: false,
      },
      ...overrides,
    } as SessionState);
    const stateRef = useRef(state);
    stateRef.current = state;
    const sessionIdRef = useRef<string | null>("s");
    useExecutionRecovery({
      state,
      dispatch,
      stateRef,
      sessionIdRef,
      sessionGenerationRef: useRef(0),
      deltaBufferRef: useRef(new Map()),
      deltaRafRef: useRef<number | null>(null),
      workspace,
    });
    return state;
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  api.getSession.mockResolvedValue(session);
  api.getSessionExecution.mockResolvedValue({ state: "running", turnId: "t" });
  api.getSessionView.mockResolvedValue(snapshot("running"));
});
afterEach(() => {
  cleanup();
  clearAllStreamingText();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("read-only execution recovery", () => {
  it("does not unlock a recovered active task when an old stream closes", () => {
    const state = {
      ...initialState,
      executing: true,
      executionRecovery: {
        sessionId: "s",
        status: { state: "running" as const },
        hydrating: false,
        checking: false,
      },
    };
    expect(
      reducer(state, { type: "SET_EXECUTING", value: false }).executing,
    ).toBe(true);
  });
  it("polls the original task, then restores prose, clock and steps without an action", async () => {
    const { result } = setup();
    await waitFor(() => expect(api.getSessionView).toHaveBeenCalledOnce());
    expect(result.current.executing).toBe(true);
    expect(workspace.hydrate).not.toHaveBeenCalled();
    api.getSessionExecution.mockResolvedValue({
      state: "completed",
      turnId: "t",
    });
    api.getSessionView.mockResolvedValue(snapshot("completed"));
    await waitFor(() => expect(result.current.executing).toBe(false), {
      timeout: 5000,
    });
    expect(result.current.messages).toEqual([
      expect.objectContaining({ content: "Recovered prose" }),
    ]);
    expect(result.current.session?.completedPlayerTurns).toBe(2);
    expect(result.current.executionSteps[0]?.status).toBe("completed");
    expect(workspace.run).not.toHaveBeenCalled();
  });
  it("keeps unknown network state locked without declaring interruption", async () => {
    api.getSessionExecution.mockRejectedValue(new Error("offline"));
    const { result } = setup();
    await waitFor(() =>
      expect(result.current.executionRecovery?.error).toBe("offline"),
    );
    expect(result.current.executing).toBe(true);
    expect(result.current.executionRecovery?.status?.state).toBe("running");
    expect(workspace.run).not.toHaveBeenCalled();
  });
  it("observes the active task during hydration without publishing session data", async () => {
    const { result } = setup({
      session: null,
      executionRecovery: {
        sessionId: "s",
        status: null,
        hydrating: true,
        checking: true,
      },
    });
    await waitFor(() =>
      expect(result.current.executionRecovery?.status?.state).toBe("running"),
    );
    expect(result.current.session).toBeNull();
    expect(api.getSessionView).not.toHaveBeenCalled();
    expect(workspace.run).not.toHaveBeenCalled();
  });
});

it("terminal recovery replaces a real delta placeholder and clears queued text", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.set(++frameId, cb);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const hook = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      session,
      executing: true,
    });
    const refs = useSessionRuntimeRefs(state);
    refs.runtimeKindRef.current.set("story/main", "story");
    const stream = createSseEventHandler({
      ...refs,
      dispatch,
      ds: {} as DataService,
    });
    useExecutionRecovery({ state, dispatch, ...refs, workspace });
    return { state, dispatch, stream, refs };
  });
  const delta = {
    type: "narrative.delta",
    sessionId: "s",
    turnId: "t",
    requestId: "request",
    traceId: "trace",
    flowId: "flow",
    seq: 1,
    timestamp: "2026-01-01T00:00:00Z",
    payload: { runtimeId: "story/main", pluginId: "story", delta: "partial" },
  } as const;
  act(() => {
    hook.result.current.stream(delta);
    for (const cb of [...frames.values()]) cb(0);
  });
  expect(hook.result.current.state.messages[0]?.id).toBe("stream_t_story/main");
  expect(getStreamingText("stream_t_story/main")).toBe("partial");
  api.getSessionExecution.mockResolvedValue({
    state: "completed",
    turnId: "t",
  });
  api.getSessionView.mockResolvedValue(snapshot("completed"));
  act(() => {
    hook.result.current.stream({
      ...delta,
      seq: 2,
      payload: { ...delta.payload, delta: " queued" },
    });
    hook.result.current.dispatch({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: "s",
        status: null,
        checking: true,
        hydrating: false,
      },
    });
  });
  await waitFor(() =>
    expect(hook.result.current.state.messages[0]?.content).toBe(
      "Recovered prose",
    ),
  );
  expect(getStreamingText("stream_t_story/main")).toBeUndefined();
  expect(hook.result.current.refs.deltaBufferRef.current.size).toBe(0);
  act(() => {
    for (const cb of [...frames.values()]) cb(1);
  });
  expect(hook.result.current.state.messages).toHaveLength(1);
  expect(workspace.run).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function ownedRecovery() {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.set(++frameId, cb);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const hook = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      session,
      executing: true,
    });
    const refs = useSessionRuntimeRefs(state);
    refs.runtimeKindRef.current.set("story/main", "story");
    const stream = createSseEventHandler({
      ...refs,
      dispatch,
      ds: {} as DataService,
    });
    useExecutionRecovery({ state, dispatch, ...refs, workspace });
    return { state, dispatch, refs, stream };
  });
  const delta = (turnId: string, text: string) =>
    hook.result.current.stream({
      type: "narrative.delta",
      sessionId: "s",
      turnId,
      requestId: "request",
      traceId: "trace",
      flowId: "flow",
      seq: 1,
      timestamp: session.createdAt,
      payload: { runtimeId: "story/main", pluginId: "story", delta: text },
    });
  const flush = () => {
    for (const cb of [...frames.values()]) cb(0);
  };
  const recover = () =>
    hook.result.current.dispatch({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: "s",
        status: null,
        checking: true,
        hydrating: false,
      },
    });
  return { ...hook, delta, flush, recover, frames };
}

it.each(["new action", "revisit"])(
  "an old terminal read cannot clobber a healthy POST after %s",
  async (change) => {
    const pending = deferred<ReturnType<typeof snapshot>>();
    api.getSessionExecution.mockResolvedValue({
      state: "completed",
      turnId: "t",
    });
    api.getSessionView.mockReturnValueOnce(pending.promise);
    const { result, delta, flush, recover } = ownedRecovery();
    act(() => {
      delta("t", "old partial");
      flush();
      recover();
    });
    await waitFor(() => expect(api.getSessionView).toHaveBeenCalledOnce());
    act(() => {
      if (change === "revisit")
        result.current.refs.sessionGenerationRef.current += 2;
      result.current.dispatch({
        type: "SET_EXECUTION_RECOVERY",
        recovery: null,
      });
      result.current.dispatch({ type: "SET_EXECUTING", value: true });
      delta("new", "healthy");
      flush();
      delta("new", " queued");
    });
    await act(async () => {
      pending.resolve(snapshot("completed"));
    });
    expect(result.current.state.executing).toBe(true);
    expect(result.current.state.executionRecovery).toBeNull();
    expect(result.current.state.messages.some((m) => m.id === "m")).toBe(false);
    expect(getStreamingText("stream_new_story/main")).toBe("healthy");
    expect(result.current.refs.deltaBufferRef.current.size).toBe(1);
  },
);

it("recovery cleans only the adopted turn/runtime and preserves another scheduled flush", async () => {
  api.getSessionExecution.mockResolvedValue({
    state: "completed",
    turnId: "t",
  });
  api.getSessionView.mockResolvedValue(snapshot("completed"));
  const { result, delta, flush, recover, frames } = ownedRecovery();
  act(() => {
    delta("t", "old partial");
    flush();
    delta("t", " queued");
    delta("other", "unrelated");
    recover();
  });
  await waitFor(() =>
    expect(result.current.state.messages[0]?.content).toBe("Recovered prose"),
  );
  expect(getStreamingText("stream_t_story/main")).toBeUndefined();
  expect(result.current.refs.deltaBufferRef.current.size).toBe(1);
  expect(frames.size).toBe(1);
  act(flush);
  expect(getStreamingText("stream_other_story/main")).toBe("unrelated");
  expect(
    result.current.state.messages.filter((m) => m.turnId === "t"),
  ).toHaveLength(1);
});

it("terminal polling retries a failed bridge read without publishing a discontinuous window", async () => {
  vi.useFakeTimers();
  api.getSessionExecution.mockResolvedValue({
    state: "completed",
    turnId: "t",
  });
  api.getSessionView.mockResolvedValue({
    ...snapshot("completed"),
    messagesCursor: "opaque-m",
  });
  api.listMessagesPage.mockRejectedValue(new Error("offline"));
  const { result, unmount } = setup({
    messages: [
      {
        id: "old",
        role: "assistant",
        content: "Old history",
        kind: "story",
        turnId: "old-turn",
        runtimeId: "story/main",
        timestamp: session.createdAt,
      },
    ],
  });
  await act(async () => {});
  expect(result.current.messages.map((m) => m.id)).toEqual(["old"]);
  expect(result.current.executionRecovery?.checking).toBe(true);
  expect(result.current.executionRecovery?.error).toBe(
    "__i18n:session.reasonHistoryRestoreFailed__",
  );
  api.listMessagesPage.mockResolvedValue({
    items: [
      {
        id: "old",
        role: "assistant",
        content: "Old history",
        kind: "story",
        turnId: "old-turn",
        runtimeId: "story/main",
        createdAt: session.createdAt,
      },
    ],
    nextCursor: null,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(result.current.messages.map((m) => m.id)).toEqual(["old", "m"]);
  expect(result.current.executing).toBe(false);
  expect(result.current.executionRecovery?.error).toBeUndefined();
  expect(workspace.run).not.toHaveBeenCalled();
  unmount();
});
