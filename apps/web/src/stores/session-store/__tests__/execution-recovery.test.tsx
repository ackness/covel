import { useReducer, useRef } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../types.js";
import { initialState, reducer } from "../reducer.js";

const api = vi.hoisted(() => ({
  getSessionExecution: vi.fn(),
  getSessionView: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("@/services/api.js", () => api);
const { useExecutionRecovery } = await import("../execution-recovery.js");
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
  locale: "en-US",
  createdAt: "now",
  updatedAt: "now",
  presetId: null,
};
function snapshot(state: "running" | "completed") {
  return {
    session,
    execution: { state, turnId: "t" },
    messages:
      state === "completed"
        ? [
            {
              id: "m",
              role: "assistant",
              content: "Recovered prose",
              turnId: "t",
              kind: "story",
              createdAt: "now",
            },
          ]
        : [],
    executionSteps: [
      {
        type: state === "completed" ? "runtime.completed" : "runtime.started",
        turnId: "t",
        timestamp: "now",
        payload: {
          runtimeId: "story",
          pluginId: "story",
          status: state === "completed" ? "success" : "running",
        },
      },
    ],
    characters: [],
    gameState: {},
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
  vi.useRealTimers();
});

describe("read-only execution recovery", () => {
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
