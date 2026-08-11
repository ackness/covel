import type { DataService } from "@/services/data-service.js";
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
  turnCount: 0,
  activePlugins: ["pregame", "world-init"],
  locale: "en-US",
  createdAt: "2026-08-09T00:00:00.000Z",
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
    syncToServer: vi.fn(async () => {
      order.push("sync");
    }),
  } as unknown as DataService;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSlotConfig.mockReturnValue({});
  api.getPrepRuntimeBindings.mockReturnValue({ narrator: "fast" });
  api.updateSession.mockResolvedValue(session);
  api.getSessionSnapshot.mockResolvedValue({});
  hydration.hydratePluginDataForUiSpecs.mockResolvedValue(undefined);
});

describe("startGameSession bootstrap order", () => {
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

    await startGameSession({
      ds: makeDataService(order),
      dispatch,
      sessionIdRef: { current: null },
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

    await startGameSession({
      ds: makeDataService([]),
      dispatch,
      sessionIdRef: { current: null },
      world,
      presets: [],
      llmConfig: null,
      plugins: ["pregame", "world-init"],
    });

    expect(api.clearPrepRuntimeBindings).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_SESSION", session });
  });
});
