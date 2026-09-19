import { act, renderHook } from "@testing-library/react";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { useBuildSessionActions } from "../actions.js";
import { initialState, reducer } from "../reducer.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";

const api = vi.hoisted(() => ({
  getSessionView: vi.fn(),
  getSession: vi.fn(),
  listSessionPlugins: vi.fn(),
  listSuspensions: vi.fn(),
  markServerAck: vi.fn(),
  getSlotConfig: vi.fn(() => ({})),
  getPrepRuntimeBindings: vi.fn(() => ({})),
  steerTurn: vi.fn(),
}));
vi.mock("@/services/api", () => api);

const world: WorldRecord = {
  id: "world-1",
  name: "World",
  description: "",
  createdAt: "2026-09-06T00:00:00.000Z",
};
const session: SessionRecord = {
  id: "sess-1",
  worldId: world.id,
  status: "active",
  phase: "setup",
  completedPlayerTurns: 0,
  setupRuntimes: {},
  activePlugins: [],
  locale: "en-US",
  createdAt: world.createdAt,
  updatedAt: world.createdAt,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const handleSseEvent = vi.fn();
  const ds = {
    getSession: vi.fn(async () => session),
    createSession: vi.fn(async () => session),
    loadSubmittedBlocks: vi.fn(async () => ({ ids: [], values: {} })),
    loadExecutionSteps: vi.fn(async () => []),
    listMessagesPage: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
  };
  const workspace = {
    hydrate: vi.fn(async (): Promise<void> => undefined),
    run: vi.fn(),
    checkpoint: vi.fn(),
  };
  const hook = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      world,
      worlds: [world],
    });
    const refs = useSessionRuntimeRefs(state);
    const actions = useBuildSessionActions({
      state,
      dispatch,
      refs,
      ds: ds as unknown as DataService,
      workspace: workspace as SessionWorkspace,
      handleSseEvent,
    });
    return { actions, state };
  });
  return { ...hook, ds, workspace, handleSseEvent };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSessionView.mockResolvedValue({
    session,
    messages: [],
    messagesCursor: "latest-cursor",
    characters: [],
    gameState: {},
    characterSchema: null,
    executionSteps: [],
    execution: { state: "idle" },
  });
  api.getSession.mockImplementation(async (id: string) => ({ ...session, id }));
  api.listSessionPlugins.mockResolvedValue({ items: [], commands: [] });
  api.listSuspensions.mockResolvedValue([]);
});

describe("session navigation lifecycle", () => {
  it("applies steering and resumed runtime results while the same visit remains active", async () => {
    const { result, workspace } = setup();
    await act(async () => {
      await result.current.actions.resumeSession(session);
    });
    api.steerTurn.mockResolvedValueOnce(true);
    let applied!: boolean;
    await act(async () => {
      applied = await result.current.actions.steerMessage("current input");
    });
    expect(applied).toBe(true);
    expect(result.current.state.messages[0]?.content).toBe("current input");
    workspace.run.mockResolvedValueOnce({
      result: {
        runtimeId: "current-runtime",
        pluginId: "current-plugin",
        status: "completed",
        durationMs: 7,
      },
      events: [],
    });
    await act(async () => {
      await result.current.actions.resumeSuspension("current-suspension", {});
    });
    expect(result.current.state.executionSteps).toEqual([
      expect.objectContaining({
        runtimeId: "current-runtime",
        status: "completed",
        durationMs: 7,
      }),
    ]);
  });

  it.each(["sess-1", "sess-2"])(
    "drops a steering reply after navigating to %s",
    async (nextId) => {
      const { result } = setup();
      await act(async () => {
        await result.current.actions.resumeSession(session);
      });
      const response = deferred<boolean>();
      api.steerTurn.mockReturnValueOnce(response.promise);
      const steering =
        result.current.actions.steerMessage("old steering input");
      act(() => result.current.actions.backToWorldSelect());
      await act(async () => {
        await result.current.actions.resumeSession({ ...session, id: nextId });
      });
      let applied!: boolean;
      await act(async () => {
        response.resolve(true);
        applied = await steering;
      });
      expect(applied).toBe(false);
      expect(result.current.state.messages).toEqual([]);
    },
  );

  it.each(["sess-1", "sess-2"])(
    "drops a resumed runtime after navigating to %s",
    async (nextId) => {
      const { result, workspace, handleSseEvent } = setup();
      await act(async () => {
        await result.current.actions.resumeSession(session);
      });
      const response = deferred<unknown>();
      workspace.run.mockReturnValueOnce(response.promise);
      const resuming = result.current.actions.resumeSuspension(
        "old-suspension",
        {},
      );
      act(() => result.current.actions.backToWorldSelect());
      await act(async () => {
        await result.current.actions.resumeSession({ ...session, id: nextId });
      });
      await act(async () => {
        response.resolve({
          result: {
            runtimeId: "old-runtime",
            pluginId: "old-plugin",
            status: "completed",
          },
          events: [
            {
              type: "runtime.completed",
              sessionId: session.id,
              turnId: "old-turn",
              timestamp: session.updatedAt,
              payload: {},
              source: { runtimeId: "old-runtime", pluginId: "old-plugin" },
            },
          ],
        });
        await resuming;
      });
      expect(result.current.state.executionSteps).toEqual([]);
      expect(handleSseEvent).not.toHaveBeenCalled();
    },
  );

  it("does not rewind pagination when a duplicate older request settles late", async () => {
    const { result, ds } = setup();
    await act(async () => {
      await result.current.actions.resumeSession(session);
    });
    const stale = deferred<unknown>();
    ds.listMessagesPage.mockReturnValueOnce(stale.promise);
    const delayed = result.current.actions.loadOlderMessages();
    ds.listMessagesPage.mockResolvedValueOnce({
      items: [],
      nextCursor: "middle-cursor",
    });
    await act(async () => {
      await result.current.actions.loadOlderMessages();
    });
    ds.listMessagesPage.mockResolvedValueOnce({ items: [], nextCursor: null });
    await act(async () => {
      await result.current.actions.loadOlderMessages();
    });
    await act(async () => {
      stale.resolve({ items: [], nextCursor: "middle-cursor" });
      await delayed;
    });
    expect(result.current.state.olderMessagesCursor).toBeNull();
  });

  it("drops history from a previous visit to the same session", async () => {
    const { result, ds } = setup();
    await act(async () => {
      await result.current.actions.resumeSession(session);
    });
    const response = deferred<unknown>();
    ds.listMessagesPage.mockReturnValueOnce(response.promise);
    const loading = result.current.actions.loadOlderMessages();
    act(() => result.current.actions.backToWorldSelect());
    await act(async () => {
      await result.current.actions.resumeSession(session);
    });
    await act(async () => {
      response.resolve({
        items: [
          {
            id: "obsolete-history",
            role: "assistant",
            content: "old",
            createdAt: session.createdAt,
          },
        ],
        nextCursor: null,
      });
      await loading;
    });
    expect(result.current.state.messages).toEqual([]);
    expect(result.current.state.olderMessagesCursor).toBe("latest-cursor");
  });

  it("does not let a slow session lookup replace a newer selection", async () => {
    const { result, ds, workspace } = setup();
    const lookup = deferred<SessionRecord>();
    ds.getSession.mockReturnValueOnce(lookup.promise);
    const first = result.current.actions.resumeSessionById(session.id);
    await act(async () => {
      await result.current.actions.resumeSession({ ...session, id: "sess-2" });
    });
    await act(async () => {
      lookup.resolve(session);
      await first;
    });
    expect(result.current.state.session?.id).toBe("sess-2");
    expect(workspace.hydrate).toHaveBeenCalledTimes(1);
  });

  it.each(["resetSession", "backToWorldSelect", "selectWorld"] as const)(
    "cancels a pending lookup when %s leaves an already empty session",
    async (action) => {
      const { result, ds, workspace } = setup();
      const lookup = deferred<SessionRecord>();
      ds.getSession.mockReturnValueOnce(lookup.promise);
      const restoring = result.current.actions.resumeSessionById(session.id);
      act(() => result.current.actions[action](world.id));
      await act(async () => {
        lookup.resolve(session);
        await restoring;
      });
      expect(result.current.state.session).toBeNull();
      expect(workspace.hydrate).not.toHaveBeenCalled();
    },
  );

  it("does not hydrate after its provider unmounts during a lookup", async () => {
    const { result, ds, workspace, unmount } = setup();
    const lookup = deferred<SessionRecord>();
    ds.getSession.mockReturnValueOnce(lookup.promise);
    const restoring = result.current.actions.resumeSessionById(session.id);
    unmount();
    lookup.resolve(session);
    await restoring;
    expect(workspace.hydrate).not.toHaveBeenCalled();
  });

  it("discards a stale hydration failure after the player leaves", async () => {
    const { result, workspace } = setup();
    const hydration = deferred<void>();
    workspace.hydrate.mockReturnValueOnce(hydration.promise);
    let restoring!: Promise<void>;
    act(() => {
      restoring = result.current.actions.resumeSession(session);
    });
    act(() => result.current.actions.backToWorldSelect());
    await act(async () => {
      hydration.reject(new Error("old failure"));
      await restoring;
    });
    expect(result.current.state.session).toBeNull();
    expect(result.current.state.executionError).toBeNull();
  });

  it("does not publish an in-progress new game after leaving its world", async () => {
    const { result, workspace } = setup();
    const hydration = deferred<void>();
    workspace.hydrate.mockReturnValueOnce(hydration.promise);
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.actions.startGame();
      await Promise.resolve();
    });
    expect(workspace.hydrate).toHaveBeenCalledOnce();
    act(() => result.current.actions.backToWorldSelect());
    await act(async () => {
      hydration.resolve();
      await starting;
    });
    expect(result.current.state.session).toBeNull();
    expect(result.current.state.world).toBeNull();
  });

  it.each([
    { stage: "workspace", nextId: null },
    { stage: "workspace", nextId: "sess-2" },
    { stage: "snapshot", nextId: null },
    { stage: "snapshot", nextId: "sess-2" },
  ])(
    "handles a failed $stage bootstrap after navigating to $nextId",
    async ({ stage, nextId }) => {
      const { result, ds, workspace } = setup();
      const failure = deferred<never>();
      if (stage === "workspace") {
        workspace.hydrate.mockReturnValueOnce(failure.promise);
      } else {
        api.getSessionView.mockReturnValueOnce(failure.promise);
      }

      let starting!: Promise<void>;
      await act(async () => {
        starting = result.current.actions.startGame();
      });
      expect(workspace.hydrate).toHaveBeenCalledOnce();
      if (stage === "snapshot") {
        expect(api.getSessionView).toHaveBeenCalledOnce();
        expect(result.current.state.session?.id).toBe(session.id);
      }

      act(() => result.current.actions.backToWorldSelect());
      if (nextId) {
        await act(async () => {
          await result.current.actions.resumeSession({
            ...session,
            id: nextId,
          });
        });
      }
      const stateAfterNavigation = result.current.state;

      await act(async () => {
        failure.reject(new Error("old bootstrap failed"));
        await starting;
      });

      if (stage === "workspace") {
        expect(ds.deleteSession).toHaveBeenCalledExactlyOnceWith(session.id);
      } else {
        expect(ds.deleteSession).not.toHaveBeenCalled();
      }
      expect(result.current.state).toBe(stateAfterNavigation);
      expect(result.current.state.executionError).toBeNull();
    },
  );

  it("preserves a published session reopened and left before its old snapshot fails", async () => {
    const { result, ds } = setup();
    const snapshot = deferred<never>();
    api.getSessionView.mockReturnValueOnce(snapshot.promise);
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.actions.startGame();
    });
    expect(result.current.state.session?.id).toBe(session.id);

    act(() => result.current.actions.backToWorldSelect());
    await act(async () => {
      await result.current.actions.resumeSession(session);
    });
    expect(result.current.state.session?.id).toBe(session.id);
    act(() => result.current.actions.backToWorldSelect());
    const stateAfterNavigation = result.current.state;

    await act(async () => {
      snapshot.reject(new Error("old snapshot failed"));
      await starting;
    });

    expect(ds.deleteSession).not.toHaveBeenCalled();
    expect(result.current.state).toBe(stateAfterNavigation);
  });
});
