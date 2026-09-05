import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", () => ({
  getSessionView: vi.fn(),
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
import { initialState } from "../session-store/reducer.js";
import type { SessionState } from "../session-store/types.js";
import {
  isCurrentSubscriptionEvent,
  rehydrateSessionSideState,
} from "../session-store/subscription.js";

function sessionPlugin(id: string, active: boolean): api.SessionPlugin {
  return {
    id,
    displayName: id === "p1" ? "P1" : "Off",
    description: "",
    pluginType: "plugin",
    source: "builtin",
    status: "registered",
    runtimeCount: 0,
    capabilities: [],
    tags: [],
    runtimes: [],
    tools: [],
    userSettings: [],
    active,
    locked: false,
  };
}

const snapshot = {
  session: {
    id: "s1",
    worldId: "w1",
    phase: "playing" as const,
    completedPlayerTurns: 2,
    setupRuntimes: {},
  },
  messages: [],
  characters: [],
  gameState: { hp: 7 },
  executionSteps: [],
  plugins: [],
};

function observation(executing = false) {
  const state: SessionState = {
    ...initialState,
    session: {
      ...snapshot.session,
      locale: "en-US",
      status: "active",
      activePlugins: [],
      createdAt: "now",
      updatedAt: "now",
    },
    executing,
    executionSteps: [
      {
        runtimeId: "story",
        pluginId: "story",
        turnId: "t1",
        status: "running",
      },
    ],
  };
  return {
    stateRef: { current: state },
    activeTurnIdRef: { current: "t1" as string | null },
  };
}

describe("rehydrateSessionSideState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listSessionPlugins).mockResolvedValue({
      commands: [],
      items: [sessionPlugin("p1", true), sessionPlugin("off", false)],
    });
    vi.mocked(api.listPluginData).mockResolvedValue([
      {
        namespace: "stage",
        key: "current",
        value: { scene: "dock" },
        updatedAt: "t",
      },
    ]);
    vi.mocked(api.getSessionView).mockResolvedValue(snapshot);
    vi.mocked(api.listSuspensions).mockResolvedValue([
      {
        id: "susp-1",
        sessionId: "s1",
        turnId: "t1",
        runtimeId: "p1/run",
        pluginId: "p1",
        createdAt: "t",
      },
    ]);
    vi.mocked(api.getWorld).mockResolvedValue({
      id: "w1",
      name: "World",
    } as api.WorldRecord);
  });

  it("adopts the still-running server task after its action connection ended", async () => {
    const owner = observation();
    vi.mocked(api.getSessionView).mockResolvedValue({
      ...snapshot,
      execution: { state: "running", turnId: "t1" },
    });
    const dispatch = vi.fn();
    await rehydrateSessionSideState(
      "s1",
      { current: "s1" },
      dispatch,
      () => true,
      owner,
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: "s1",
        status: { state: "running", turnId: "t1" },
        checking: false,
        hydrating: false,
      },
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "LOAD_EXECUTION_STEPS",
      steps: [expect.objectContaining({ status: "running" })],
    });
  });

  it.each(["running", "completed", "failed"] as const)(
    "does not replace a healthy POST stream with a %s snapshot",
    async (state) => {
      const owner = observation(true);
      vi.mocked(api.getSessionView).mockResolvedValue({
        ...snapshot,
        execution: { state, turnId: "t1" },
      });
      const dispatch = vi.fn();
      await rehydrateSessionSideState(
        "s1",
        { current: "s1" },
        dispatch,
        () => true,
        owner,
      );
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
      );
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOAD_EXECUTION_STEPS" }),
      );
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_SESSION" }),
      );
    },
  );

  it("surfaces confirmed interruption of the current POST turn without a page refresh", async () => {
    const owner = observation(true);
    vi.mocked(api.getSessionView).mockResolvedValue({
      ...snapshot,
      execution: { state: "interrupted", turnId: "t1" },
    });
    const dispatch = vi.fn();
    await rehydrateSessionSideState(
      "s1",
      { current: "s1" },
      dispatch,
      () => true,
      owner,
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: "s1",
        status: { state: "interrupted", turnId: "t1" },
        checking: false,
        hydrating: false,
      },
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "LOAD_EXECUTION_STEPS",
      steps: [expect.objectContaining({ status: "failed" })],
    });
  });

  it("does not apply another turn's interrupted status to the active POST", async () => {
    const owner = observation(true);
    vi.mocked(api.getSessionView).mockResolvedValue({
      ...snapshot,
      execution: { state: "interrupted", turnId: "older-turn" },
    });
    const dispatch = vi.fn();
    await rehydrateSessionSideState(
      "s1",
      { current: "s1" },
      dispatch,
      () => true,
      owner,
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
    );
  });

  it("drops execution recovery if a new POST starts while the snapshot is in flight", async () => {
    const owner = observation();
    let release!: (
      value: typeof snapshot & {
        execution: { state: "interrupted"; turnId: string };
      },
    ) => void;
    vi.mocked(api.getSessionView).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const dispatch = vi.fn();
    const pending = rehydrateSessionSideState(
      "s1",
      { current: "s1" },
      dispatch,
      () => true,
      owner,
    );
    owner.stateRef.current = { ...owner.stateRef.current, executing: true };
    release({ ...snapshot, execution: { state: "interrupted", turnId: "t1" } });
    await pending;
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "LOAD_EXECUTION_STEPS" }),
    );
  });

  it("rejects an old snapshot after consecutive POSTs even before the new turn ID arrives", async () => {
    const owner = observation(true);
    let release!: (
      value: typeof snapshot & {
        execution: { state: "interrupted"; turnId: string };
      },
    ) => void;
    vi.mocked(api.getSessionView).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const dispatch = vi.fn();
    const pending = rehydrateSessionSideState(
      "s1",
      { current: "s1" },
      dispatch,
      () => true,
      owner,
    );
    owner.stateRef.current = { ...owner.stateRef.current, actionGeneration: 2 };
    release({ ...snapshot, execution: { state: "interrupted", turnId: "t1" } });
    await pending;
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "LOAD_EXECUTION_STEPS" }),
    );
  });

  it("rehydrates plugins, plugin data, suspensions, game state and world", async () => {
    const dispatch = vi.fn();
    vi.mocked(api.getSessionView).mockResolvedValue({
      ...snapshot,
      messages: [
        {
          id: "missed-story",
          role: "assistant",
          kind: "story",
          runtimeId: "story-runtime",
          turnId: "turn-1",
          content: "Recovered story",
          createdAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    });
    await rehydrateSessionSideState("s1", { current: "s1" }, dispatch);
    expect(dispatch).toHaveBeenCalledWith({
      type: "MERGE_RECOVERED_MESSAGES",
      messages: [
        expect.objectContaining({
          id: "missed-story",
          kind: "story",
          content: "Recovered story",
        }),
      ],
    });

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

  it("drops a snapshot superseded by a newer recovery generation", async () => {
    let release!: (value: typeof snapshot) => void;
    vi.mocked(api.getSessionView).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    let current = true;
    const dispatch = vi.fn();
    const pending = rehydrateSessionSideState(
      "s1",
      { current: "s1" },
      dispatch,
      () => current,
    );
    current = false;
    release(snapshot);
    await pending;
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "MERGE_RECOVERED_MESSAGES" }),
    );
  });

  it("drops every async result after the active session changes", async () => {
    let release!: (value: typeof snapshot) => void;
    vi.mocked(api.getSessionView).mockReturnValue(
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

describe("session subscription event ownership", () => {
  const event = {
    id: "e1",
    topic: "plugin" as const,
    type: "plugin-data.changed",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {},
  };

  it("drops the old stream immediately after the active session ref changes", () => {
    expect(isCurrentSubscriptionEvent(event, "s1", "s2")).toBe(false);
  });

  it("drops cross-session envelopes even on the current connection", () => {
    expect(
      isCurrentSubscriptionEvent({ ...event, sessionId: "s2" }, "s1", "s1"),
    ).toBe(false);
  });
});
