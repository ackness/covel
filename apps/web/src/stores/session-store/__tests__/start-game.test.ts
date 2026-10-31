// @vitest-environment node
import type { DataService } from "@/services/data-service.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { LocalDataService } from "@/services/data-service/local.js";
import { BrowserVault } from "@/services/storage/browser-vault.js";
import { fakeSessionServer } from "@/services/__tests__/support/fake-session-server.js";
import { createSessionWorkspace } from "@/services/data-service/workspace.js";
import {
  BASE_ACTION_KINDS,
  BASE_ACTION_KIND_RULES,
  baseActionKindRoles,
  ROLE_ACTION_KINDS,
} from "@covel/shared";
import { deriveComposerModes } from "@/components/session/game-view/composer-modes.js";
import { initialState, reducer } from "../reducer.js";
import { createSseEventHandler } from "../sse-handler.js";
import { resyncSessionRecord, runActionStream } from "../runtime-rpc.js";
import { refreshSessionActionKinds } from "../action-kinds-refresh.js";
import type { SessionAction } from "../types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPrepRuntimeBindings: vi.fn(),
  updateSession: vi.fn(),
  clearPrepRuntimeBindings: vi.fn(),
  getSessionView: vi.fn(),
  takeCreatedWorldDataNotices: vi.fn(() => []),
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getWorld: vi.fn(),
  updateWorld: vi.fn(),
  uploadBrowserCheckpoint: vi.fn(),
  fetchBrowserCommit: vi.fn(),
  sendAction: vi.fn<typeof import("@/services/api/actions.js").sendAction>(),
  getSessionActionKinds: vi.fn(),
}));
const hydration = vi.hoisted(() => ({
  hydratePluginDataForUiSpecs: vi.fn(),
}));

vi.mock("@/services/api", () => api);
vi.mock("../plugin-data-hydration.js", () => hydration);
vi.mock("@/stores/plugin-data-store.js", () => ({
  setActiveSession: vi.fn(),
}));

const { startGameSession } = await import("../start-game.js");

const session: SessionRecord = {
  id: "sess-1",
  worldId: "world-1",
  status: "active",
  phase: "setup",
  autoAdvanceLimit: 3,
  completedPlayerTurns: 0,
  setupRuntimes: {},
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ],
  activePlugins: ["pregame", "world-init"],
  locale: "en-US",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};
const world = {
  id: "world-1",
  name: "World",
  description: "",
  createdAt: "2026-08-09T00:00:00.000Z",
} as WorldRecord;

function makeDataService(order: string[]): DataService {
  return {
    createSession: vi.fn(async () => {
      order.push("create");
      return session;
    }),
    getSession: vi.fn(async () => session),
    syncToServer: vi.fn(async () => {
      order.push("sync");
    }),
    updateSession: vi.fn((sessionId, updates) =>
      api.updateSession(sessionId, updates),
    ),
    deleteSession: vi.fn(async () => {
      order.push("delete");
    }),
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
  api.getPrepRuntimeBindings.mockReturnValue({ narrator: "fast" });
  api.updateSession.mockResolvedValue(session);
  api.getSessionView.mockResolvedValue({});
  hydration.hydratePluginDataForUiSpecs.mockResolvedValue(undefined);
});

describe("startGameSession bootstrap order", () => {
  it.each([
    ["player", ["say", "act"]],
    ["host", ["narrate", "direct", "advance"]],
    ["spectator", ["advance"]],
  ] as const)(
    "preserves the %s seat and composer actions through local bootstrap and opening",
    async (seatRole, expectedModes) => {
      const vault = new BrowserVault({
        dbName: `role-bootstrap-${crypto.randomUUID()}`,
      });
      try {
        await vault.upsertWorld({
          id: world.id,
          name: "World",
          description: "",
          createdAt: world.createdAt,
        });
        const ds = new LocalDataService(vault);
        const workspace = createSessionWorkspace(ds, "local");
        let opened = false;
        const story = {
          id: "opening-story",
          role: "assistant" as const,
          kind: "story" as const,
          turnId: "opening",
          content: "The hall opens.",
          createdAt: session.createdAt,
        };
        const server = fakeSessionServer({
          vault: () => vault,
          initialize: () => ({ phase: "setup" }),
          patch: (checkpoint) =>
            opened
              ? {
                  session: { ...checkpoint.session, phase: "playing" },
                  messages: [{ ...story, sessionId: checkpoint.sessionId }],
                }
              : undefined,
        });
        api.getWorld.mockResolvedValue(world);
        api.updateWorld.mockResolvedValue(world);
        api.createSession.mockImplementation(server.createSession);
        api.fetchBrowserCommit.mockImplementation(server.fetchBrowserCommit);
        api.uploadBrowserCheckpoint.mockImplementation(
          async (_id, checkpoint) => ({
            ok: true,
            revision: checkpoint.revision,
          }),
        );
        api.getSession.mockImplementation((id) => ds.getSession(id));
        const stateRef = { current: initialState };
        const sessionIdRef = { current: null as string | null };
        const dispatch = vi.fn((action: SessionAction) => {
          stateRef.current = reducer(stateRef.current, action);
        });
        const expectedSeats = [
          {
            id: "main",
            controller: "human",
            role: seatRole,
            characters: seatRole === "player" ? "auto" : [],
          },
        ];
        const assertSeats = async () => {
          const id = sessionIdRef.current!;
          expect(stateRef.current.session?.seats).toEqual(expectedSeats);
          expect((await ds.getSession(id))?.seats).toEqual(expectedSeats);
          expect((await vault.getLatestCheckpoint(id))?.session.seats).toEqual(
            expectedSeats,
          );
          for (const [, checkpoint] of api.uploadBrowserCheckpoint.mock.calls)
            expect(checkpoint.session.seats).toEqual(expectedSeats);
        };
        await startGameSession({
          ds,
          workspace,
          dispatch,
          sessionIdRef,
          sessionGenerationRef,
          world,
          seatRole,
        });
        const id = sessionIdRef.current!;
        expect(server.created.get(id)?.session.seats).toEqual(expectedSeats);
        expect(api.createSession.mock.calls[0]?.[7]).toBe(seatRole);
        expect(stateRef.current.session?.phase).toBe("setup");
        expect(stateRef.current.session?.runtimeModelOverrides).toEqual({
          narrator: "fast",
        });
        await assertSeats();

        api.getSessionActionKinds.mockImplementation(async () => {
          const checkpoint = await vault.getLatestCheckpoint(id);
          return {
            kinds: BASE_ACTION_KINDS.map((kind) => ({
              ...BASE_ACTION_KIND_RULES[kind],
              kind,
              roles: baseActionKindRoles(kind),
              source: "framework",
              display: { label: kind },
            })),
            seats: checkpoint!.session.seats.map((seat) => ({
              seatId: seat.id,
              role: seat.role,
              controller: seat.controller,
              allowed: ROLE_ACTION_KINDS[seat.role],
            })),
          };
        });
        const assertActions = async () => {
          await refreshSessionActionKinds(dispatch, id, () => true);
          expect(
            deriveComposerModes({
              catalogue: stateRef.current.sessionActionKinds,
              seats: stateRef.current.session!.seats,
              language: "en-US",
              baseLabel: (kind) => kind,
            }).map((mode) => mode.kind),
          ).toEqual(expectedModes);
        };
        await assertActions();
        api.sendAction.mockImplementation(
          (request, onEvent, _onError, onDone) => {
            expect(request.type).toBe("start_session");
            expect(request.sessionId).toBe(id);
            opened = true;
            const emit = (
              type: import("@/services/api.js").SseEnvelope["type"],
              payload: Record<string, unknown>,
            ) =>
              onEvent({
                type,
                payload,
                sessionId: id,
                turnId: story.turnId,
                requestId: request.requestId,
                traceId: "opening-trace",
                flowId: "opening-flow",
                seq: 1,
                timestamp: story.createdAt,
              });
            emit("execution.started", {});
            emit("narrative.completed", {
              ...story,
              messageId: story.id,
              runtimeId: "story/main",
            });
            emit("execution.completed", { committed: true });
            onDone?.();
            return new AbortController();
          },
        );
        const requestId = crypto.randomUUID();
        await workspace.run(id, requestId, () =>
          runActionStream(
            { requestId, type: "start_session", sessionId: id, payload: {} },
            createSseEventHandler({
              ds,
              dispatch,
              stateRef,
              sessionIdRef,
              deltaBufferRef: { current: new Map() },
              deltaRafRef: { current: null },
              lastBackfilledTurnIdRef: { current: null },
            }),
            dispatch,
            { sessionIdRef },
          ),
        );
        await resyncSessionRecord(
          id,
          sessionIdRef,
          dispatch,
          sessionGenerationRef,
        );
        expect(api.sendAction).toHaveBeenCalledOnce();
        expect(stateRef.current.session?.phase).toBe("playing");
        expect(stateRef.current.session?.completedPlayerTurns).toBe(0);
        expect(stateRef.current.messages).toContainEqual(
          expect.objectContaining({ content: story.content }),
        );
        expect(await ds.listMessages(id)).toContainEqual(
          expect.objectContaining({ content: story.content }),
        );
        await workspace.hydrate(id);
        await assertSeats();
        await assertActions();
      } finally {
        await vault.deleteDatabase();
      }
    },
  );
  it.each(["Current draft", ""])(
    "persists the selected lore with the session (%j)",
    async (loreOverride) => {
      const ds = makeDataService([]);
      await startGameSession({
        ds,
        workspace: makeWorkspace(ds),
        dispatch: vi.fn(),
        sessionIdRef: { current: null },
        sessionGenerationRef,
        world,
        loreOverride,
      });
      expect(vi.mocked(ds.createSession).mock.calls[0]?.[4]).toBe(loreOverride);
    },
  );
  it("uses the world language when creating a session", async () => {
    const ds = makeDataService([]);

    await startGameSession({
      ds,
      workspace: makeWorkspace(ds),
      dispatch: vi.fn(),
      sessionIdRef: { current: null },
      sessionGenerationRef,
      world: { ...world, locale: "en-US" },
    });

    expect(ds.createSession).toHaveBeenCalledWith(
      world.id,
      undefined,
      undefined,
      "en-US",
      undefined,
      undefined,
    );
  });

  it("publishes the session only after server sync and model bindings", async () => {
    const order: string[] = [];
    api.updateSession.mockImplementation(async () => {
      order.push("bindings");
      return session;
    });
    api.clearPrepRuntimeBindings.mockImplementation(() => {
      order.push("clear-bindings");
    });
    const dispatch = vi.fn((action: { type: string }) => {
      if (action.type === "SET_SESSION") order.push("dispatch-session");
    });

    const ds = makeDataService(order);
    await startGameSession({
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef: { current: null },
      sessionGenerationRef,
      world,
      plugins: ["pregame", "world-init"],
    });

    expect(order).toEqual([
      "create",
      "sync",
      "bindings",
      "sync",
      "dispatch-session",
      "clear-bindings",
    ]);
  });

  it("rolls back without publishing and keeps prep bindings when the patch fails", async () => {
    api.updateSession.mockRejectedValue(new Error("patch failed"));
    const dispatch = vi.fn();
    const ds = makeDataService([]);

    const sessionIdRef = { current: null };
    await expect(
      startGameSession({
        ds,
        workspace: makeWorkspace(ds),
        dispatch,
        sessionIdRef,
        sessionGenerationRef,
        world,
        plugins: ["pregame", "world-init"],
      }),
    ).rejects.toThrow("patch failed");

    expect(api.clearPrepRuntimeBindings).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "SET_SESSION", session });
    expect(ds.deleteSession).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "patch failed",
    });
    expect(sessionIdRef.current).toBeNull();
  });

  it("preserves prep selections and rolls back if uploading the saved bindings fails", async () => {
    const ds = makeDataService([]);
    vi.mocked(ds.syncToServer)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("binding sync failed"));
    const dispatch = vi.fn();
    await expect(
      startGameSession({
        ds,
        workspace: makeWorkspace(ds),
        dispatch,
        sessionIdRef: { current: null },
        sessionGenerationRef,
        world,
      }),
    ).rejects.toThrow("binding sync failed");
    expect(api.clearPrepRuntimeBindings).not.toHaveBeenCalled();
    expect(api.getSessionView).not.toHaveBeenCalled();
    expect(ds.deleteSession).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "SET_SESSION", session });
  });

  it("uploads local runtime bindings before publishing while retaining server-resolved setup", async () => {
    const vault = new BrowserVault({
      dbName: `prep-bootstrap-${crypto.randomUUID()}`,
    });
    try {
      await vault.upsertWorld({
        id: world.id,
        name: "World",
        description: "",
        createdAt: world.createdAt,
      });
      const ds = new LocalDataService(vault);
      api.getWorld.mockResolvedValue(world);
      api.updateWorld.mockResolvedValue(world);
      // The server resolves setup while creating the session; its first
      // export is the browser's revision 1.
      const server = fakeSessionServer({
        vault: () => vault,
        initialize: () => ({ phase: "playing" }),
      });
      api.getSession.mockResolvedValue(session);
      api.createSession.mockImplementation(server.createSession);
      api.fetchBrowserCommit.mockImplementation(server.fetchBrowserCommit);
      api.uploadBrowserCheckpoint.mockImplementation(
        async (_id, checkpoint) => ({
          ok: true,
          revision: checkpoint.revision,
        }),
      );
      const dispatch = vi.fn((action: { type: string }) => {
        if (action.type !== "SET_SESSION") return;
        const uploaded = api.uploadBrowserCheckpoint.mock.calls.at(-1)?.[1];
        expect(uploaded.session.runtimeModelOverrides).toEqual({
          narrator: "fast",
        });
        expect(uploaded.session.phase).toBe("playing");
      });
      await startGameSession({
        ds,
        workspace: createSessionWorkspace(ds, "local"),
        dispatch,
        sessionIdRef: { current: null },
        sessionGenerationRef,
        world,
      });
      expect(api.uploadBrowserCheckpoint).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_SESSION",
        session: expect.objectContaining({
          runtimeModelOverrides: { narrator: "fast" },
          phase: "playing",
        }),
      });
      expect(api.updateSession).not.toHaveBeenCalled();
    } finally {
      await vault.deleteDatabase();
    }
  });

  it("rejects visibly and removes a local session when server sync fails", async () => {
    const order: string[] = [];
    const ds = makeDataService(order);
    vi.mocked(ds.syncToServer).mockRejectedValueOnce(new Error("offline"));
    const dispatch = vi.fn();

    await expect(
      startGameSession({
        ds,
        workspace: makeWorkspace(ds),
        dispatch,
        sessionIdRef: { current: null },
        sessionGenerationRef,
        world,
      }),
    ).rejects.toThrow("offline");

    expect(ds.deleteSession).toHaveBeenCalledWith(session.id);
    expect(api.clearPrepRuntimeBindings).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "offline",
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "SET_SESSION", session });
  });

  it("clears a published session when initial snapshot hydration fails", async () => {
    api.getSessionView.mockRejectedValueOnce(new Error("snapshot failed"));
    const ds = makeDataService([]);
    vi.mocked(ds.deleteSession).mockRejectedValueOnce(
      new Error("cleanup failed"),
    );
    const dispatch = vi.fn();
    const sessionIdRef = { current: null as string | null };

    await expect(
      startGameSession({
        ds,
        workspace: makeWorkspace(ds),
        dispatch,
        sessionIdRef,
        sessionGenerationRef,
        world,
      }),
    ).rejects.toThrow("snapshot failed");

    expect(dispatch).toHaveBeenCalledWith({ type: "SET_SESSION", session });
    expect(dispatch).toHaveBeenCalledWith({ type: "RESET_SESSION" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "snapshot failed",
    });
    expect(sessionIdRef.current).toBeNull();
    expect(ds.deleteSession).toHaveBeenCalledWith(session.id);
    expect(api.clearPrepRuntimeBindings).not.toHaveBeenCalled();
  });

  it("keeps newer prep selections when bootstrap finishes", async () => {
    let resolveSnapshot!: (snapshot: Record<string, unknown>) => void;
    api.getSessionView.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const ds = makeDataService([]);
    const starting = startGameSession({
      ds,
      workspace: makeWorkspace(ds),
      dispatch: vi.fn(),
      sessionIdRef: { current: null },
      sessionGenerationRef,
      world,
    });
    await vi.waitFor(() => expect(api.getSessionView).toHaveBeenCalled());
    api.getPrepRuntimeBindings.mockReturnValue({ narrator: "balance" });
    resolveSnapshot({});
    await starting;

    expect(ds.updateSession).toHaveBeenCalledWith(session.id, {
      runtimeModelOverrides: { narrator: "fast" },
    });
    expect(api.clearPrepRuntimeBindings).not.toHaveBeenCalled();
  });

  it("drops an initial snapshot that resolves after a session switch", async () => {
    let resolveSnapshot!: (snapshot: Record<string, unknown>) => void;
    api.getSessionView.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const ds = makeDataService([]);
    const dispatch = vi.fn();
    const sessionIdRef = { current: null as string | null };

    const starting = startGameSession({
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef,
      sessionGenerationRef,
      world,
    });
    await vi.waitFor(() => expect(sessionIdRef.current).toBe(session.id));
    sessionIdRef.current = "sess-b";
    resolveSnapshot({ scene: "session A" });
    await starting;

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_GAME_STATE" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith({ type: "RESET_SESSION" });
    expect(ds.deleteSession).not.toHaveBeenCalled();
  });

  it("does not delete a reopened session when an older bootstrap snapshot fails", async () => {
    let rejectSnapshot!: (error: Error) => void;
    api.getSessionView.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectSnapshot = reject;
      }),
    );
    const ds = makeDataService([]);
    const dispatch = vi.fn();
    const sessionIdRef = { current: null as string | null };
    const starting = startGameSession({
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef,
      sessionGenerationRef,
      world,
    });
    await vi.waitFor(() => expect(api.getSessionView).toHaveBeenCalled());
    sessionGenerationRef.current += 1;
    dispatch.mockClear();
    rejectSnapshot(new Error("old snapshot failed"));
    await starting;
    expect(sessionIdRef.current).toBe(session.id);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ds.deleteSession).not.toHaveBeenCalled();
  });

  it("does not delete a session adopted while its initial workspace hydration is pending", async () => {
    const ds = makeDataService([]);
    let rejectHydration!: (error: Error) => void;
    vi.mocked(ds.syncToServer).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectHydration = reject;
      }),
    );
    const dispatch = vi.fn();
    const sessionIdRef = { current: null as string | null };
    const starting = startGameSession({
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef,
      sessionGenerationRef,
      world,
    });
    await vi.waitFor(() => expect(ds.syncToServer).toHaveBeenCalled());
    sessionGenerationRef.current += 1;
    sessionIdRef.current = session.id;
    dispatch.mockClear();

    rejectHydration(new Error("old hydration failed"));
    await starting;

    expect(sessionIdRef.current).toBe(session.id);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ds.deleteSession).not.toHaveBeenCalled();
  });

  it("suppresses a bootstrap error when the player leaves during rollback", async () => {
    const ds = makeDataService([]);
    vi.mocked(ds.syncToServer).mockRejectedValueOnce(new Error("offline"));
    let resolveDeletion!: () => void;
    vi.mocked(ds.deleteSession).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDeletion = resolve;
      }),
    );
    const dispatch = vi.fn();
    const starting = startGameSession({
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef: { current: null },
      sessionGenerationRef,
      world,
    });
    await vi.waitFor(() => expect(ds.deleteSession).toHaveBeenCalled());
    sessionGenerationRef.current += 1;
    dispatch.mockClear();

    resolveDeletion();
    await starting;

    expect(ds.deleteSession).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
