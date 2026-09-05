import type { DataService } from "@/services/data-service.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSlotConfig: vi.fn(),
  getPrepRuntimeBindings: vi.fn(),
  updateSession: vi.fn(),
  clearPrepRuntimeBindings: vi.fn(),
  getSessionSnapshot: vi.fn(),
  markServerAck: vi.fn(),
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
  completedPlayerTurns: 0,
  setupRuntimes: {},
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
  api.getSlotConfig.mockReturnValue({});
  api.getPrepRuntimeBindings.mockReturnValue({ narrator: "fast" });
  api.updateSession.mockResolvedValue(session);
  api.getSessionSnapshot.mockResolvedValue({});
  hydration.hydratePluginDataForUiSpecs.mockResolvedValue(undefined);
});

describe("startGameSession bootstrap order", () => {
  it("uses the world language when creating a session", async () => {
    const ds = makeDataService([]);

    await startGameSession({
      ds,
      workspace: makeWorkspace(ds),
      dispatch: vi.fn(),
      sessionIdRef: { current: null },
      sessionGenerationRef,
      world: { ...world, locale: "en-US" },
      presets: [],
      llmConfig: null,
    });

    expect(ds.createSession).toHaveBeenCalledWith(
      world.id,
      undefined,
      undefined,
      undefined,
      "en-US",
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
      presets: [],
      llmConfig: null,
      plugins: ["pregame", "world-init"],
    });

    expect(order).toEqual([
      "create",
      "sync",
      "bindings",
      "clear-bindings",
      "dispatch-session",
    ]);
    expect(api.markServerAck).toHaveBeenCalledOnce();
  });

  it("keeps prep bindings when the server patch fails", async () => {
    api.updateSession.mockRejectedValue(new Error("patch failed"));
    const dispatch = vi.fn();
    const ds = makeDataService([]);

    await startGameSession({
      ds,
      workspace: makeWorkspace(ds),
      dispatch,
      sessionIdRef: { current: null },
      sessionGenerationRef,
      world,
      presets: [],
      llmConfig: null,
      plugins: ["pregame", "world-init"],
    });

    expect(api.clearPrepRuntimeBindings).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_SESSION", session });
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
        presets: [],
        llmConfig: null,
      }),
    ).rejects.toThrow("offline");

    expect(ds.deleteSession).toHaveBeenCalledWith(session.id);
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "offline",
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "SET_SESSION", session });
  });

  it("clears a published session when initial snapshot hydration fails", async () => {
    api.getSessionSnapshot.mockRejectedValueOnce(new Error("snapshot failed"));
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
        presets: [],
        llmConfig: null,
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
  });

  it("drops an initial snapshot that resolves after a session switch", async () => {
    let resolveSnapshot!: (snapshot: Record<string, unknown>) => void;
    api.getSessionSnapshot.mockReturnValueOnce(
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
      presets: [],
      llmConfig: null,
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
    api.getSessionSnapshot.mockReturnValueOnce(
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
      presets: [],
      llmConfig: null,
    });
    await vi.waitFor(() => expect(api.getSessionSnapshot).toHaveBeenCalled());
    sessionGenerationRef.current += 1;
    dispatch.mockClear();
    rejectSnapshot(new Error("old snapshot failed"));
    await starting;
    expect(sessionIdRef.current).toBe(session.id);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ds.deleteSession).not.toHaveBeenCalled();
  });
});
