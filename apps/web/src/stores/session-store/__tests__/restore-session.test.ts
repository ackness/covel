import type { DataService } from "@/services/data-service.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useReducer } from "react";
import { initialState, reducer } from "../reducer.js";
import { projectExecutionTurns } from "../execution-projection.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";

const api = vi.hoisted(() => ({
  getSessionView: vi.fn(),
  listSessionPlugins: vi.fn(),
  listSuspensions: vi.fn(),
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

const { restoreSessionState, toStreamMessages } =
  await import("../restore-session.js");

const session: SessionRecord = {
  id: "sess-1",
  worldId: "world-1",
  status: "active",
  phase: "setup",
  completedPlayerTurns: 0,
  setupRuntimes: {},
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ],
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
    characterSchema: null,
    executionSteps: [],
    submittedInteractions: [],
  };
}

function makeDataService(order: string[]): DataService {
  return {
    syncToServer: vi.fn(async () => {
      order.push("sync");
    }),
    listMessages: vi.fn(async () => []),
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
  it("retains cached durable control identity and sequence through restore", async () => {
    const ds = makeDataService([]);
    const step = {
      runtimeId: "worker",
      pluginId: "worker",
      turnId: "source",
      status: "completed",
      jobId: "job",
      detached: true,
      jobState: "succeeded",
      durableJobStatus: { state: "succeeded", sequence: 4 },
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
  it("retains reasoning and diagnostic fields when their server trace window has expired", async () => {
    const ds = makeDataService([]);
    const step = {
      runtimeId: "tracker",
      pluginId: "tracker",
      turnId: "old-turn",
      status: "failed",
      toolName: "tracker.lookup",
      abortReason: "manual-abort",
      reasoning: [
        {
          id: "reasoning",
          content: "Captured reasoning",
          timestamp: "2026-09-05T00:00:00Z",
          model: "test-model",
          sequence: 1,
        },
      ],
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
    expect(pluginData.setActiveSession).toHaveBeenLastCalledWith(null);
  });
});

describe("restoreSessionState submitted interactions", () => {
  it("marks a form the server holds an answer for, and the server's values replace the browser's", async () => {
    const ds = makeDataService([]);
    vi.mocked(ds.loadSubmittedBlocks).mockResolvedValue({
      ids: ["m-form"],
      values: { "m-form": { name: "Stale local" } },
    });
    api.getSessionView.mockResolvedValue({
      ...emptySnapshot(),
      messages: [
        {
          id: "m-form",
          role: "assistant",
          content: "",
          turnId: "t1",
          createdAt: "2026-08-25T00:00:00.000Z",
          block: { type: "interactive_form", data: { interactionId: "name" } },
        },
        {
          id: "m-open",
          role: "assistant",
          content: "",
          turnId: "t1",
          createdAt: "2026-08-25T00:00:01.000Z",
          block: { type: "interactive_form", data: { interactionId: "other" } },
        },
      ],
      submittedInteractions: [
        {
          turnId: "t1",
          interactionId: "name",
          values: { name: "Aria" },
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
    const submitted = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === "SUBMIT_BLOCK");
    expect(submitted).toEqual([
      {
        type: "SUBMIT_BLOCK",
        blockId: "m-form",
        values: { name: "Stale local" },
      },
      { type: "SUBMIT_BLOCK", blockId: "m-form", values: { name: "Aria" } },
    ]);
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

describe("toStreamMessages", () => {
  it("keeps a story message's segments", () => {
    const segments = [
      { kind: "narration" as const, text: "雨停了。" },
      {
        kind: "dialogue" as const,
        speaker: "阿雅",
        speakerId: "char-aya",
        text: "「走吧。」",
      },
    ];
    const [story, plain] = toStreamMessages([
      {
        id: "story-1",
        role: "assistant",
        content: "雨停了。\n\n「走吧。」",
        kind: "story",
        segments,
        createdAt: "2026-10-30T00:00:00.000Z",
      },
      {
        id: "system-1",
        role: "system",
        content: "通知",
        createdAt: "2026-10-30T00:00:01.000Z",
      },
    ]);
    expect(story?.segments).toEqual(segments);
    expect(plain).not.toHaveProperty("segments");
  });
});

describe("restoreSessionState runtime run identities", () => {
  it.each([undefined, "", 42])(
    "keeps cached runs separate and adopts an anonymous row with raw run id %j",
    async (runId) => {
      const ds = makeDataService([]);
      const reasoning = [
        {
          id: "nested-reasoning",
          content: "Nested reasoning",
          timestamp: "2026-10-01T00:00:01Z",
        },
      ];
      const legacyReasoning = [
        {
          id: "legacy-reasoning",
          content: "Legacy reasoning",
          timestamp: "2026-10-01T00:00:00Z",
        },
      ];
      vi.mocked(ds.loadExecutionSteps).mockResolvedValue([
        {
          turnId: "turn",
          runtimeId: "story",
          pluginId: "story",
          runId: "nested",
          resumed: true,
          status: "completed",
          reasoning,
        },
        {
          turnId: "turn",
          runtimeId: "legacy",
          pluginId: "legacy",
          runId,
          status: "running",
          reasoning: legacyReasoning,
        },
      ]);
      api.getSessionView.mockResolvedValue({
        ...emptySnapshot(),
        executionSteps: ["story", "legacy"].map((runtimeId) => ({
          type: "runtime.completed",
          turnId: "turn",
          timestamp: "2026-10-01T00:00:02Z",
          payload: {
            runtimeId,
            pluginId: runtimeId,
            runId: runtimeId === "story" ? "outer" : "identified",
            status: "success",
          },
        })),
      });
      let state = initialState;
      await restoreSessionState({
        ds,
        workspace: makeWorkspace(ds),
        dispatch: (action) => {
          state = reducer(state, action);
        },
        sessionIdRef: { current: null },
        sessionGenerationRef,
        worlds: [world],
        session,
      });
      expect(state.executionSteps).toHaveLength(3);
      expect(
        state.executionSteps.find((step) => step.runId === "nested"),
      ).toMatchObject({ status: "completed", reasoning, resumed: true });
      expect(
        state.executionSteps.find((step) => step.runId === "outer")?.reasoning,
      ).toBeUndefined();
      expect(
        state.executionSteps.find((step) => step.runtimeId === "legacy"),
      ).toMatchObject({
        runId: "identified",
        status: "completed",
        reasoning: legacyReasoning,
      });
    },
  );

  it("keeps resume completion visible when restoring only cached lifecycle rows", async () => {
    const ds = makeDataService([]);
    vi.mocked(ds.loadExecutionSteps).mockResolvedValue([
      {
        turnId: "turn",
        runtimeId: "story",
        pluginId: "story",
        runId: "original",
        status: "suspended",
        startedAt: "2026-10-01T00:00:00Z",
      },
      {
        turnId: "turn",
        runtimeId: "story",
        pluginId: "story",
        runId: "continuation",
        resumed: true,
        status: "completed",
        startedAt: "2026-10-01T00:00:01Z",
      },
    ]);
    let state = initialState;
    await restoreSessionState({
      ds,
      workspace: makeWorkspace(ds),
      dispatch: (action) => {
        state = reducer(state, action);
      },
      sessionIdRef: { current: null },
      sessionGenerationRef,
      worlds: [world],
      session,
    });
    expect(
      projectExecutionTurns([], state.executionSteps).turns[0]?.steps,
    ).toEqual([
      expect.objectContaining({
        runId: "continuation",
        status: "completed",
        resumed: true,
      }),
    ]);
  });
});
