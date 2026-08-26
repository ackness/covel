import type { DataService } from "@/services/data-service.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSessionSnapshot: vi.fn(),
  listSessionPlugins: vi.fn(),
  listSuspensions: vi.fn(),
  markServerAck: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  api.getSessionSnapshot.mockResolvedValue(emptySnapshot());
  api.listSessionPlugins.mockResolvedValue({ active: [], available: [] });
  api.listSuspensions.mockResolvedValue([]);
});

describe("restoreSessionState workspace ordering", () => {
  it("hydrates the server workspace before publishing the session", async () => {
    const order: string[] = [];
    const ds = makeDataService(order);
    const dispatch = vi.fn((action: { type: string }) => {
      if (action.type === "SET_SESSION") order.push("publish");
    });
    api.getSessionSnapshot.mockImplementation(async () => {
      order.push("snapshot");
      return emptySnapshot();
    });
    api.listSessionPlugins.mockImplementation(async () => {
      order.push("plugins");
      return { active: [], available: [] };
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
        worlds: [world],
        session,
      }),
    ).rejects.toThrow("offline");

    expect(sessionIdRef.current).toBeNull();
    expect(dispatch).not.toHaveBeenCalledWith({ type: "SET_SESSION", session });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "offline",
    });
    expect(api.getSessionSnapshot).not.toHaveBeenCalled();
    expect(api.listSessionPlugins).not.toHaveBeenCalled();
    expect(api.listSuspensions).not.toHaveBeenCalled();
    expect(api.markServerAck).not.toHaveBeenCalled();
    expect(pluginData.setActiveSession).toHaveBeenLastCalledWith(null);
  });
});
