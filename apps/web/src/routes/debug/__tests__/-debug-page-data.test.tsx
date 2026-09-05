import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as api from "@/services/api.js";
import { useDebugPageData, type SessionSnapshot } from "../-debug-page-data.js";

const mocks = vi.hoisted(() => ({
  listWorlds: vi.fn(),
  listSessions: vi.fn(),
  getSessionView: vi.fn(),
  fetchTraceTurnsPage: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/services/api.js", () => mocks);
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

function snapshot(id = "session-a", completedPlayerTurns = 0): SessionSnapshot {
  return {
    session: {
      id,
      worldId: "world-a",
      phase: completedPlayerTurns ? "playing" : "setup",
      completedPlayerTurns,
      setupRuntimes: {},
    },
    characters: [],
    messages: [],
    interactions: [],
    timeline: [],
  } as unknown as SessionSnapshot;
}

function trace(turnId: string): api.TurnTrace {
  return {
    turnId,
    flowId: turnId,
    traceId: turnId,
    startedAt: turnId,
    completedAt: turnId,
    events: [],
    eventCount: 0,
  };
}

describe("debugger refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listWorlds.mockResolvedValue([{ id: "world-a" }]);
    mocks.listSessions.mockResolvedValue([
      {
        ...snapshot().session,
        status: "active",
        activePlugins: [],
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ]);
    mocks.getSessionView.mockImplementation(async (id) => snapshot(id));
    mocks.fetchTraceTurnsPage.mockResolvedValue({
      turns: [trace("2")],
      nextCursor: "older",
    });
  });
  afterEach(() => vi.useRealTimers());

  it("refreshes visible data and the sidebar summary without switching tabs", async () => {
    const { result } = renderHook(() => useDebugPageData("session-a"), {
      wrapper: StrictMode,
    });
    await waitFor(() =>
      expect(result.current.snapshotData?.session.phase).toBe("setup"),
    );
    act(() => result.current.setDebugView("data"));
    mocks.getSessionView.mockResolvedValue(snapshot("session-a", 2));
    await act(async () => result.current.refresh());
    expect(result.current.snapshotData?.session.completedPlayerTurns).toBe(2);
    expect(result.current.sessions[0]?.completedPlayerTurns).toBe(2);
    expect(result.current.sessions[0]?.phase).toBe("playing");
    expect(result.current.snapshotUpdatedAt).toBeTruthy();
  });

  it("polls data and summary while retaining previously loaded trace pages", async () => {
    const { result } = renderHook(() => useDebugPageData("session-a"));
    await waitFor(() => expect(result.current.snapshotData).not.toBeNull());
    mocks.fetchTraceTurnsPage.mockResolvedValueOnce({
      turns: [trace("1")],
      nextCursor: "oldest",
    });
    await act(async () => result.current.loadOlder());
    mocks.fetchTraceTurnsPage.mockResolvedValue({
      turns: [trace("3")],
      nextCursor: "older",
    });
    mocks.getSessionView.mockResolvedValue(snapshot("session-a", 3));
    vi.useFakeTimers();
    act(() => result.current.setAutoRefresh(true));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(result.current.turns.map((turn) => turn.turnId)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(result.current.isPartial).toBe(true);
    expect(result.current.snapshotData?.session.completedPlayerTurns).toBe(3);
    expect(result.current.sessions[0]?.completedPlayerTurns).toBe(3);
  });

  it("marks failed data refreshes stale and recovers without losing the snapshot", async () => {
    const { result } = renderHook(() => useDebugPageData("session-a"));
    await waitFor(() => expect(result.current.snapshotData).not.toBeNull());
    const previous = result.current.snapshotData;
    mocks.getSessionView.mockRejectedValueOnce(new Error("offline"));
    await act(async () => result.current.refresh());
    expect(result.current.snapshotError).toBe(true);
    expect(result.current.snapshotData).toBe(previous);
    expect(result.current.snapshotLoading).toBe(false);
    await act(async () => result.current.refresh());
    expect(result.current.snapshotError).toBe(false);
  });

  it("allows a slow snapshot read to finish across multiple polling ticks", async () => {
    const { result } = renderHook(() => useDebugPageData("session-a"));
    await waitFor(() => expect(result.current.snapshotData).not.toBeNull());
    let release!: (value: SessionSnapshot) => void;
    mocks.getSessionView.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const initialReads = mocks.getSessionView.mock.calls.length;
    vi.useFakeTimers();
    act(() => result.current.setAutoRefresh(true));
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(mocks.getSessionView).toHaveBeenCalledTimes(initialReads + 1);
    await act(async () => release(snapshot("session-a", 4)));
    expect(result.current.snapshotData?.session.completedPlayerTurns).toBe(4);
    expect(result.current.snapshotLoading).toBe(false);
  });

  it("ignores a response from the previous session after switching", async () => {
    const { result } = renderHook(() => useDebugPageData("session-a"));
    await waitFor(() => expect(result.current.snapshotData).not.toBeNull());
    let resolvePrevious!: (value: SessionSnapshot) => void;
    mocks.getSessionView.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrevious = resolve;
        }),
    );
    let previousRequest!: Promise<void>;
    act(() => {
      previousRequest = result.current.refreshSnapshot();
    });
    act(() => result.current.selectSession("session-b"));
    await waitFor(() =>
      expect(result.current.snapshotData?.session.id).toBe("session-b"),
    );
    await act(async () => {
      resolvePrevious(snapshot("session-a", 99));
      await previousRequest;
    });
    expect(result.current.snapshotData?.session.id).toBe("session-b");
    expect(result.current.snapshotError).toBe(false);
  });
});
