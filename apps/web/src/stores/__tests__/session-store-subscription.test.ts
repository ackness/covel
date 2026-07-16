import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", () => ({
  getSessionSnapshot: vi.fn(),
  getWorld: vi.fn(),
  listPluginData: vi.fn(),
  listSessionPlugins: vi.fn(),
  listSuspensions: vi.fn(),
}));

vi.mock("@/stores/plugin-data-store.js", () => ({
  replaceSessionPluginData: vi.fn(),
}));

import * as api from "@/services/api";
import { replaceSessionPluginData } from "@/stores/plugin-data-store.js";
import { rehydrateSessionSideState } from "../session-store/subscription.js";

const snapshot = {
  session: { id: "s1", worldId: "w1", turnCount: 2 },
  messages: [],
  characters: [],
  gameState: { hp: 7 },
  executionSteps: [],
  plugins: [],
};

describe("rehydrateSessionSideState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listSessionPlugins).mockResolvedValue({
      active: ["p1"],
      available: [
        { id: "p1", displayName: "P1", isActive: true },
        { id: "off", displayName: "Off", isActive: false },
      ],
    });
    vi.mocked(api.listPluginData).mockResolvedValue([
      {
        namespace: "stage",
        key: "current",
        value: { scene: "dock" },
        updatedAt: "t",
      },
    ]);
    vi.mocked(api.getSessionSnapshot).mockResolvedValue(snapshot);
    vi.mocked(api.listSuspensions).mockResolvedValue([
      {
        id: "susp-1",
        sessionId: "s1",
        turnId: "t1",
        runtimeId: "p1/run",
        pluginId: "p1",
        suspendedAt: "t",
      },
    ]);
    vi.mocked(api.getWorld).mockResolvedValue({
      id: "w1",
      name: "World",
    } as api.WorldRecord);
  });

  it("rehydrates plugins, plugin data, suspensions, game state and world", async () => {
    const dispatch = vi.fn();
    await rehydrateSessionSideState("s1", { current: "s1" }, dispatch);

    expect(api.listPluginData).toHaveBeenCalledTimes(1);
    expect(api.listPluginData).toHaveBeenCalledWith("s1", "p1");
    expect(replaceSessionPluginData).toHaveBeenCalledWith("s1", {
      p1: { stage: { current: { scene: "dock" } } },
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "REPLACE_PLUGIN_DATA",
      pluginData: { p1: { stage: { current: { scene: "dock" } } } },
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_SUSPENSIONS",
      suspensions: expect.arrayContaining([
        expect.objectContaining({ id: "susp-1" }),
      ]),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_GAME_STATE",
      state: expect.objectContaining({ hp: 7 }),
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "UPDATE_WORLD",
      world: expect.objectContaining({ id: "w1" }),
    });
  });

  it("drops every async result after the active session changes", async () => {
    let release!: (value: typeof snapshot) => void;
    vi.mocked(api.getSessionSnapshot).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const sessionRef = { current: "s1" as string | null };
    const dispatch = vi.fn();
    const pending = rehydrateSessionSideState("s1", sessionRef, dispatch);

    sessionRef.current = "s2";
    release(snapshot);
    await pending;

    expect(dispatch).not.toHaveBeenCalled();
    expect(replaceSessionPluginData).not.toHaveBeenCalled();
  });
});
