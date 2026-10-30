import { useReducer, useRef } from "react";
import {
  act,
  cleanup,
  render,
  renderHook,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionRecoveryNotice } from "@/components/session/execution-recovery-notice.js";
import i18n from "@/i18n/index.js";
import { runActionStream } from "../runtime-rpc.js";
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
  sendAction: vi.fn(),
  getSessionExecution: vi.fn(),
  getSessionView: vi.fn(),
  getSession: vi.fn(),
  listMessagesPage: vi.fn(),
}));
vi.mock("@/services/api.js", () => api);
const { useExecutionRecovery, MAX_UNKNOWN_CHECKS } =
  await import("../execution-recovery.js");
const { useExecutionRecoveryActions } =
  await import("../execution-recovery-actions.js");
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
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ] as const,
  locale: "en-US",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
function snapshot(state: "running" | "completed") {
  return {
    session,
    execution: { state, turnId: "t" },
    submittedInteractions: [],
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
  it("leaves restoring when the restore finishes while a status read is on its way", async () => {
    let answer!: (status: { state: "idle" }) => void;
    const read = new Promise<{ state: "idle" }>((resolve) => {
      answer = resolve;
    });
    api.getSessionExecution.mockReturnValue(read);
    const { result } = renderHook(() => {
      const [state, dispatch] = useReducer(reducer, {
        ...initialState,
        session,
        executing: true,
        executionRecovery: {
          sessionId: "s",
          status: null,
          hydrating: true,
          checking: true,
        },
      } as SessionState);
      const stateRef = useRef(state);
      stateRef.current = state;
      useExecutionRecovery({
        state,
        dispatch,
        stateRef,
        sessionIdRef: useRef<string | null>("s"),
        sessionGenerationRef: useRef(0),
        deltaBufferRef: useRef(new Map()),
        deltaRafRef: useRef<number | null>(null),
        workspace,
      });
      return { state, dispatch };
    });
    await waitFor(() => expect(api.getSessionExecution).toHaveBeenCalledOnce());
    // The restore publishes its result and the read answers before React
    // renders again, so the read still holds the values it started with.
    await act(async () => {
      result.current.dispatch({
        type: "SET_EXECUTION_RECOVERY",
        recovery: {
          sessionId: "s",
          status: { state: "idle" },
          hydrating: false,
          checking: false,
        },
      });
      answer({ state: "idle" });
      await read;
    });
    expect(result.current.state.executionRecovery?.hydrating).toBe(false);
    expect(result.current.state.executing).toBe(false);
  });
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
    payload: {
      runtimeId: "story/main",
      pluginId: "story",
      kind: "story",
      delta: "partial",
    },
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
      payload: {
        runtimeId: "story/main",
        pluginId: "story",
        kind: "story",
        delta: text,
      },
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

function setVisibilityForTest(initial: DocumentVisibilityState = "visible") {
  let current = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => current,
  );
  return (next: DocumentVisibilityState) => {
    current = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

it("backs off failed polls to 30 seconds and resets after a successful observation", async () => {
  vi.useFakeTimers();
  setVisibilityForTest();
  api.getSessionExecution.mockRejectedValue(new Error("offline"));
  setup();
  await act(async () => {});
  expect(api.getSessionExecution).toHaveBeenCalledWith("s", { retry: false });
  let calls = 1;
  for (const delay of [3000, 6000, 12000, 24000, 30000, 30000]) {
    await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
    expect(api.getSessionExecution).toHaveBeenCalledTimes(calls);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(api.getSessionExecution).toHaveBeenCalledTimes(++calls);
  }
  api.getSessionExecution.mockResolvedValue({ state: "running", turnId: "t" });
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(api.getSessionExecution).toHaveBeenCalledTimes(++calls);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api.getSessionExecution).toHaveBeenCalledTimes(++calls);
});

it("pauses recovery while hidden, resumes immediately and removes its listener on unmount", async () => {
  vi.useFakeTimers();
  const setVisibility = setVisibilityForTest("hidden");
  const { unmount } = setup();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(api.getSessionExecution).not.toHaveBeenCalled();
  await act(async () => setVisibility("visible"));
  expect(api.getSessionExecution).toHaveBeenCalledOnce();
  await act(async () => setVisibility("hidden"));
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(api.getSessionExecution).toHaveBeenCalledOnce();
  await act(async () => setVisibility("visible"));
  expect(api.getSessionExecution).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => {
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(api.getSessionExecution).toHaveBeenCalledTimes(2);
});

it("does not overlap a pending recovery read when visibility changes", async () => {
  vi.useFakeTimers();
  const setVisibility = setVisibilityForTest();
  const pending = deferred<{ state: "running"; turnId: string }>();
  api.getSessionExecution.mockReturnValueOnce(pending.promise);
  setup();
  await act(async () => {
    setVisibility("hidden");
    setVisibility("visible");
  });
  expect(api.getSessionExecution).toHaveBeenCalledOnce();
  await act(async () => pending.resolve({ state: "running", turnId: "t" }));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(api.getSessionExecution).toHaveBeenCalledTimes(2);
});

it.each(["failed", "interrupted"] as const)(
  "keeps unmatched %s prose as an unsaved local copy and drains its stream",
  async (state) => {
    api.getSessionExecution.mockResolvedValue({ state, turnId: "t" });
    api.getSessionView.mockResolvedValue({
      ...snapshot("running"),
      execution: { state, turnId: "t" },
    });
    const { result, delta, flush, recover, frames } = ownedRecovery();
    act(() => {
      delta("t", "Already read");
      flush();
      delta("t", " queued");
      recover();
    });
    await waitFor(() => expect(result.current.state.executing).toBe(false));
    expect(result.current.state.unsavedNarratives).toEqual([
      expect.objectContaining({ turnId: "t", content: "Already read queued" }),
    ]);
    expect(result.current.state.messages).toEqual([]);
    expect(getStreamingText("stream_t_story/main")).toBeUndefined();
    expect(result.current.refs.deltaBufferRef.current.size).toBe(0);
    expect(result.current.refs.deltaRafRef.current).toBeNull();
    act(() => {
      for (const cb of frames.values()) cb(1);
    });
    expect(result.current.state.messages).toEqual([]);
    expect(workspace.run).not.toHaveBeenCalled();
    act(() => result.current.dispatch({ type: "RESET_SESSION" }));
    expect(result.current.state.unsavedNarratives).toEqual([]);
  },
);

describe("a status the server could not check (F-203)", () => {
  const unknown = { state: "unknown" as const };
  beforeEach(() => {
    api.getSessionExecution.mockResolvedValue(unknown);
    api.getSessionView.mockResolvedValue({
      ...snapshot("running"),
      execution: unknown,
    });
  });

  it("checks again less often, stops after a few answers and checks again on refresh", async () => {
    vi.useFakeTimers();
    setVisibilityForTest();
    const runKernelAction = vi.fn();
    const { result } = renderHook(() => {
      const [state, dispatch] = useReducer(reducer, {
        ...initialState,
        session,
        executing: true,
        executionRecovery: {
          sessionId: "s",
          status: unknown,
          hydrating: false,
          checking: false,
        },
      } as SessionState);
      const stateRef = useRef(state);
      stateRef.current = state;
      useExecutionRecovery({
        state,
        dispatch,
        stateRef,
        sessionIdRef: useRef<string | null>("s"),
        sessionGenerationRef: useRef(0),
        deltaBufferRef: useRef(new Map()),
        deltaRafRef: useRef<number | null>(null),
        workspace,
      });
      const actions = useExecutionRecoveryActions({
        stateRef,
        dispatch,
        runKernelAction,
        resumeSessionById: async () => {},
      });
      return { state, ...actions };
    });
    await act(async () => {});
    let calls = 1;
    expect(api.getSessionExecution).toHaveBeenCalledTimes(calls);
    for (const delay of [3000, 6000, 12000, 24000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
      expect(api.getSessionExecution).toHaveBeenCalledTimes(calls);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(api.getSessionExecution).toHaveBeenCalledTimes(++calls);
    }
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(api.getSessionExecution).toHaveBeenCalledTimes(MAX_UNKNOWN_CHECKS);
    expect(result.current.state.executionRecovery).toMatchObject({
      status: unknown,
      stalled: true,
    });
    // Still treated as possibly running: no new turn, no retry, no restore.
    expect(result.current.state.executing).toBe(true);
    act(() => result.current.retryInterruptedTurn());
    expect(runKernelAction).not.toHaveBeenCalled();
    expect(workspace.hydrate).not.toHaveBeenCalled();

    api.getSessionExecution.mockResolvedValue({
      state: "completed",
      turnId: "t",
    });
    api.getSessionView.mockResolvedValue(snapshot("completed"));
    await act(async () => {
      result.current.refreshExecutionRecovery();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.getSessionExecution).toHaveBeenCalledTimes(
      MAX_UNKNOWN_CHECKS + 1,
    );
    expect(result.current.state.executing).toBe(false);
    expect(result.current.state.executionRecovery?.stalled).toBeUndefined();
  });

  it.each([undefined, "restore failed"])(
    "stops unknown checks even while hydration is unfinished (error: %s)",
    async (error) => {
      vi.useFakeTimers();
      setVisibilityForTest();
      const { result } = setup({
        session: null,
        executionRecovery: {
          sessionId: "s",
          status: unknown,
          hydrating: true,
          checking: true,
          ...(error ? { error } : {}),
        },
      });
      await act(async () => vi.advanceTimersByTimeAsync(45_000));
      expect(result.current.executionRecovery).toMatchObject({
        status: unknown,
        hydrating: true,
        stalled: true,
      });
      await act(async () => vi.advanceTimersByTimeAsync(300_000));
      expect(api.getSessionExecution).toHaveBeenCalledTimes(MAX_UNKNOWN_CHECKS);
      expect(result.current.executing).toBe(true);
      expect(workspace.hydrate).not.toHaveBeenCalled();
    },
  );

  it("keeps the turn's streamed prose and running steps without finishing them", async () => {
    const { result, delta, flush, recover } = ownedRecovery();
    act(() => {
      delta("t", "Already read");
      flush();
      recover();
    });
    await waitFor(() =>
      expect(result.current.state.executionRecovery?.status).toEqual(unknown),
    );
    expect(result.current.state.executing).toBe(true);
    expect(result.current.state.unsavedNarratives).toEqual([]);
    expect(getStreamingText("stream_t_story/main")).toBe("Already read");
    expect(result.current.state.executionSteps).not.toHaveLength(0);
    expect(
      result.current.state.executionSteps.map((step) => step.status),
    ).not.toContain("failed");
    expect(workspace.hydrate).not.toHaveBeenCalled();
  });
});

it("offers Continue for a live stopped opening with no runtime steps, using the guarded recovery action", async () => {
  await i18n.changeLanguage("en-US");
  const stopped = {
    state: "failed" as const,
    turnId: "opening",
    abortReason: "aborted-by-player",
    retry: { type: "retry_turn" as const, payload: {} },
  };
  api.getSessionExecution.mockResolvedValue(stopped);
  api.getSessionView.mockResolvedValue({
    ...snapshot("completed"),
    execution: stopped,
    messages: [],
    executionSteps: [],
  });
  const runKernelAction = vi.fn();
  let startStream!: () => Promise<void>;
  function LiveOpening() {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      session,
      executing: true,
    });
    const refs = useSessionRuntimeRefs(state);
    const handle = createSseEventHandler({
      dispatch,
      ds: {} as DataService,
      ...refs,
    });
    useExecutionRecovery({ state, dispatch, ...refs, workspace });
    const { retryInterruptedTurn } = useExecutionRecoveryActions({
      stateRef: refs.stateRef,
      dispatch,
      runKernelAction,
      resumeSessionById: vi.fn(),
    });
    startStream = () =>
      runActionStream(
        {
          requestId: "start",
          sessionId: "s",
          type: "start_session",
          payload: {},
        },
        handle,
        dispatch,
        { sessionIdRef: refs.sessionIdRef },
      );
    return (
      <ExecutionRecoveryNotice
        recovery={state.executionRecovery}
        steps={state.executionSteps}
        onOpenSettings={vi.fn()}
        onRetry={retryInterruptedTurn}
        onRefresh={vi.fn()}
        onStop={vi.fn()}
      />
    );
  }
  render(<LiveOpening />);
  let pending!: Promise<void>;
  act(() => {
    pending = startStream();
  });
  const [, onEvent, , onDone] = api.sendAction.mock.calls[0]!;
  await act(async () => {
    const envelope = {
      sessionId: "s",
      requestId: "start",
      traceId: "trace",
      flowId: "flow",
      seq: 1,
      timestamp: session.createdAt,
    };
    onEvent({
      ...envelope,
      turnId: "setup",
      type: "execution.started",
      payload: {},
    });
    onEvent({
      ...envelope,
      seq: 2,
      turnId: "opening",
      type: "execution.completed",
      payload: { committed: false, abortReason: "aborted-by-player" },
    });
    onDone();
    await pending;
  });
  const button = await screen.findByRole("button", { name: "Continue" });
  expect(screen.getByText("Stopped; turn not committed")).toBeTruthy();
  expect(runKernelAction).not.toHaveBeenCalled();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(runKernelAction).toHaveBeenCalledExactlyOnceWith({
    sessionId: "s",
    requestId: expect.any(String),
    type: "retry_turn",
    payload: { recoverFromTurnId: "opening" },
  });
});
