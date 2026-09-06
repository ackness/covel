import type { DataService } from "@/services/data-service.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useReducer } from "react";
import { initialState, reducer } from "../reducer.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";

const api = vi.hoisted(() => ({
  getSessionView: vi.fn(),
  listSessionPlugins: vi.fn(),
  listSuspensions: vi.fn(),
  markServerAck: vi.fn(),
  getSession: vi.fn(),
}));
const pluginData = vi.hoisted(() => ({
  setActiveSession: vi.fn(),
}));

vi.mock("@/services/api", () => api);
vi.mock("@/stores/plugin-data-store.js", () => pluginData);
vi.mock("@/stores/streaming-text-store.js", () => ({
  clearAllStreamingText: vi.fn(),
}));

const { restoreSessionState } = await import("../restore-session.js");

const session: SessionRecord = {
  id: "sess-1",
  worldId: "world-1",
  status: "active",
  phase: "setup",
  completedPlayerTurns: 0,
  setupRuntimes: {},
  activePlugins: [],
  locale: "en-US",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};
const world = {
  id: "world-1",
  name: "World",
  description: "",
  createdAt: "2026-08-25T00:00:00.000Z",
} as WorldRecord;

function emptySnapshot() {
  return {
    session,
    messages: [],
    messagesCursor: null,
    characters: [],
    gameState: {},
    characterSchema: null,
    executionSteps: [],
  };
}

function makeDataService(order: string[]): DataService {
  return {
    syncToServer: vi.fn(async () => {
      order.push("sync");
    }),
    listMessages: vi.fn(async () => []),
    listStatePatches: vi.fn(async () => []),
    loadSubmittedBlocks: vi.fn(async () => ({ ids: [], values: {} })),
    loadExecutionSteps: vi.fn(async () => []),
  } as unknown as DataService;
}

function makeWorkspace(ds: DataService): SessionWorkspace {
  return {
    hydrate: (sessionId) => ds.syncToServer(sessionId),
    run: (_sessionId, _actionId, mutate) => mutate(),
    checkpoint: () => Promise.resolve(),
  };
}

const sessionGenerationRef = { current: 0 };

beforeEach(() => {
  sessionGenerationRef.current = 0;
  vi.clearAllMocks();
  api.getSessionView.mockResolvedValue(emptySnapshot());
  api.getSession.mockResolvedValue(session);
  api.listSessionPlugins.mockResolvedValue({ items: [], commands: [] });
  api.listSuspensions.mockResolvedValue([]);
});

describe("restoreSessionState workspace ordering", () => {
  it("retains persisted retry source, actual attempt, and commit evidence", async () => {
    const ds = makeDataService([]);
    const step = {
      runtimeId: "tracker",
      pluginId: "tracker",
      turnId: "retry",
      sourceTurnId: "source",
      sourceCommitted: true,
      sourceFailedRuntimeIds: ["tracker", "remaining"],
      attemptStatus: "committed",
      status: "completed",
      turnStartedAt: "2026-09-05T00:00:00Z",
    };
    vi.mocked(ds.loadExecutionSteps).mockResolvedValue([step]);
    const dispatch = vi.fn();
    await restoreSessionState({
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef: { current: null },
      sessionGenerationRef,
      worlds: [world],
      session,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "LOAD_EXECUTION_STEPS",
      steps: [expect.objectContaining(step)],
    });
  });
  it("restores authoritative terminal steps and the updated session clock", async () => {
    const ds = makeDataService([]);
    vi.mocked(ds.loadExecutionSteps).mockResolvedValue([
      { runtimeId: "story", pluginId: "story", turnId: "t", status: "running" },
    ]);
    api.getSession.mockResolvedValue({
      ...session,
      phase: "playing",
      completedPlayerTurns: 1,
    });
    api.getSessionView.mockResolvedValue({
      ...emptySnapshot(),
      execution: { state: "completed", turnId: "t" },
      executionSteps: [
        {
          type: "runtime.completed",
          turnId: "t",
          timestamp: "now",
          payload: { runtimeId: "story", pluginId: "story", status: "success" },
        },
      ],
    });
    const dispatch = vi.fn();
    await restoreSessionState({
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef: { current: null },
      sessionGenerationRef,
      worlds: [world],
      session,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "LOAD_EXECUTION_STEPS",
      steps: [
        expect.objectContaining({ runtimeId: "story", status: "completed" }),
      ],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_SESSION",
      session: expect.objectContaining({
        completedPlayerTurns: 1,
        phase: "playing",
      }),
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "UPSERT_EXECUTION_STEP" }),
    );
  });
  it("hydrates the server workspace before publishing the session", async () => {
    const order: string[] = [];
    const ds = makeDataService(order);
    const dispatch = vi.fn((action: { type: string }) => {
      if (action.type === "SET_SESSION") order.push("publish");
    });
    api.getSessionView.mockImplementation(async () => {
      order.push("snapshot");
      return emptySnapshot();
    });
    api.listSessionPlugins.mockImplementation(async () => {
      order.push("plugins");
      return { items: [], commands: [] };
    });
    api.listSuspensions.mockImplementation(async () => {
      order.push("suspensions");
      return [];
    });
    const sessionIdRef = { current: null as string | null };

    await restoreSessionState({
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef,
      sessionGenerationRef,
      worlds: [world],
      session,
    });

    expect(order).toEqual([
      "sync",
      "publish",
      "snapshot",
      "plugins",
      "suspensions",
    ]);
    expect(api.markServerAck).toHaveBeenCalledOnce();
    expect(pluginData.setActiveSession).toHaveBeenNthCalledWith(1, null);
    expect(pluginData.setActiveSession).toHaveBeenNthCalledWith(2, session.id);
  });

  it("does not expose an executable session when workspace sync fails", async () => {
    const ds = makeDataService([]);
    vi.mocked(ds.syncToServer).mockRejectedValueOnce(new Error("offline"));
    const dispatch = vi.fn();
    const sessionIdRef = { current: null as string | null };

    await expect(
      restoreSessionState({
        ds,
        workspace: makeWorkspace(ds),
        dispatch,
        sessionIdRef,
        sessionGenerationRef,
        worlds: [world],
        session,
      }),
    ).rejects.toThrow("offline");

    expect(sessionIdRef.current).toBe(session.id);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "SET_SESSION", session });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "offline",
    });
    expect(api.getSessionView).not.toHaveBeenCalled();
    expect(api.listSessionPlugins).not.toHaveBeenCalled();
    expect(api.listSuspensions).not.toHaveBeenCalled();
    expect(api.markServerAck).not.toHaveBeenCalled();
    expect(pluginData.setActiveSession).toHaveBeenLastCalledWith(null);
  });
});

describe("restoreSessionState stale requests", () => {
  it.each(["snapshot", "fallback", "blocks", "steps"] as const)(
    "drops %s data after another session is selected",
    async (stage) => {
      const ds = makeDataService([]);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (stage === "snapshot") {
        api.getSessionView.mockImplementationOnce(async () => {
          await pending;
          return emptySnapshot();
        });
      } else if (stage === "fallback") {
        api.getSessionView.mockRejectedValueOnce(new Error("offline"));
        vi.mocked(ds.listMessages).mockImplementationOnce(async () => {
          await pending;
          return [];
        });
      } else if (stage === "blocks") {
        vi.mocked(ds.loadSubmittedBlocks).mockImplementationOnce(async () => {
          await pending;
          return { ids: ["old-block"], values: {} };
        });
      } else {
        vi.mocked(ds.loadExecutionSteps).mockImplementationOnce(async () => {
          await pending;
          return [
            {
              runtimeId: "old-runtime",
              pluginId: "plugin",
              status: "completed",
            },
          ];
        });
      }
      const dispatch = vi.fn();
      const sessionIdRef = { current: null as string | null };
      const restoring = restoreSessionState({
        ds,
        workspace: makeWorkspace(ds),
        dispatch,
        sessionIdRef,
        sessionGenerationRef,
        worlds: [world],
        session,
      });
      const waitingOn =
        stage === "snapshot"
          ? api.getSessionView
          : stage === "fallback"
            ? ds.listMessages
            : stage === "blocks"
              ? ds.loadSubmittedBlocks
              : ds.loadExecutionSteps;
      await vi.waitFor(() => expect(waitingOn).toHaveBeenCalled());
      sessionIdRef.current = "sess-2";
      dispatch.mockClear();
      release();
      await restoring;
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("keeps a newer restore of the same session when the older snapshot arrives", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.getSessionView.mockImplementationOnce(async () => {
      await pending;
      return emptySnapshot();
    });
    const ds = makeDataService([]);
    const dispatch = vi.fn();
    const sessionIdRef = { current: null as string | null };
    const options = {
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef,
      sessionGenerationRef,
      worlds: [world],
      session,
    };
    const first = restoreSessionState(options);
    await vi.waitFor(() => expect(api.getSessionView).toHaveBeenCalledOnce());
    await restoreSessionState(options);
    dispatch.mockClear();
    release();
    await first;
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("publishes a restored session after React commits the reset during hydration", async () => {
    const ds = makeDataService([]);
    let release!: () => void;
    vi.mocked(ds.syncToServer).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { result } = renderHook(() => {
      const [state, dispatch] = useReducer(reducer, {
        ...initialState,
        session: { ...session, id: "sess-old" },
      });
      const refs = useSessionRuntimeRefs(state);
      return { state, dispatch, refs };
    });
    let restoring!: Promise<void>;
    act(() => {
      restoring = restoreSessionState({
        ds,
        workspace: makeWorkspace(ds),
        dispatch: result.current.dispatch,
        sessionIdRef: result.current.refs.sessionIdRef,
        sessionGenerationRef: result.current.refs.sessionGenerationRef,
        worlds: [world],
        session,
      });
    });
    expect(result.current.refs.sessionIdRef.current).toBe(session.id);
    expect(result.current.state.session).toBeNull();
    expect(pluginData.setActiveSession).toHaveBeenLastCalledWith(null);
    await act(async () => {
      release();
      await restoring;
    });
    expect(result.current.state.session?.id).toBe(session.id);
  });
});
