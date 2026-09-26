import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PluginDiagnosticsSnapshot } from "@covel/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginDiagnosticsPanel } from "../-plugin-diagnostics-panel.js";

const mocks = vi.hoisted(() => ({ getPluginDiagnostics: vi.fn() }));
vi.mock("@/services/api.js", () => mocks);

function snapshot(
  sessionId: string,
  pluginId: string,
): PluginDiagnosticsSnapshot {
  return {
    sessionId,
    capturedAt: "2026-09-26T00:00:00Z",
    history: { scope: "process", limit: 100 },
    plugins: [
      {
        pluginId,
        source: "community",
        state: "ready",
        active: true,
        runtimeIds: ["map/runtime"],
        registrations: {
          tools: ["locate"],
          hooks: [{ id: "map-hook", event: "turn.started" }],
          actions: ["navigate"],
          services: [{ name: "lookup", contract: "map.lookup.v1" }],
        },
        commands: [{ name: "map", action: "show", registered: true }],
      },
    ],
    calls: [
      {
        callId: "call-1",
        parentCallId: "root-1",
        turnId: "turn-1",
        callerPluginId: "story",
        providerPluginId: pluginId,
        name: "lookup",
        contract: "map.lookup.v1",
        completedAt: "2026-09-26T00:00:00Z",
        durationMs: 12,
        outcome: "success",
      },
    ],
  };
}

function props(sessionId: string, pluginId?: string) {
  return {
    sessionId,
    pluginId,
    autoRefresh: false,
    refreshSignal: 0,
    onPluginFilterChange: vi.fn(),
  };
}

describe("plugin diagnostics panel", () => {
  beforeEach(() => mocks.getPluginDiagnostics.mockReset());
  afterEach(cleanup);

  it("shows registered capabilities and recent calls, then filters one plugin", async () => {
    mocks.getPluginDiagnostics.mockResolvedValue(snapshot("session-a", "map"));
    const initial = props("session-a");
    const { rerender } = render(<PluginDiagnosticsPanel {...initial} />);
    expect(await screen.findByText("map/runtime")).toBeDefined();
    expect(screen.getByText("locate")).toBeDefined();
    expect(screen.getByText("map-hook (turn.started)")).toBeDefined();
    expect(screen.getByText("navigate")).toBeDefined();
    expect(screen.getByText("lookup (map.lookup.v1)")).toBeDefined();
    expect(screen.getByText(/\/map → show/)).toBeDefined();
    expect(screen.getByText("call-1", { exact: false })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Filter|筛选/ }));
    expect(initial.onPluginFilterChange).toHaveBeenCalledWith("map");

    rerender(<PluginDiagnosticsPanel {...props("session-a", "map")} />);
    await waitFor(() =>
      expect(mocks.getPluginDiagnostics).toHaveBeenLastCalledWith(
        "session-a",
        "map",
        expect.any(AbortSignal),
      ),
    );
  });

  it("hides old session data immediately and ignores late responses", async () => {
    mocks.getPluginDiagnostics.mockResolvedValueOnce(
      snapshot("session-a", "private"),
    );
    let resolveOld!: (value: PluginDiagnosticsSnapshot) => void;
    mocks.getPluginDiagnostics.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    mocks.getPluginDiagnostics.mockResolvedValueOnce(
      snapshot("session-b", "public"),
    );
    const { rerender } = render(
      <PluginDiagnosticsPanel {...props("session-a")} />,
    );
    expect(await screen.findByText("private")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Refresh|刷新/ }));
    expect(screen.queryByText("private")).toBeNull();
    rerender(<PluginDiagnosticsPanel {...props("session-b")} />);
    expect(screen.queryByText("private")).toBeNull();
    expect(await screen.findByText("public")).toBeDefined();
    await act(async () => resolveOld(snapshot("session-a", "private")));
    expect(screen.queryByText("private")).toBeNull();
  });

  it("clears a snapshot when revalidation fails", async () => {
    mocks.getPluginDiagnostics.mockResolvedValueOnce(
      snapshot("session-a", "private"),
    );
    mocks.getPluginDiagnostics.mockRejectedValueOnce(
      new Error("owner token expired"),
    );
    render(<PluginDiagnosticsPanel {...props("session-a")} />);
    expect(await screen.findByText("private")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Refresh|刷新/ }));
    expect(screen.queryByText("private")).toBeNull();
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByText("owner token expired")).toBeNull();
  });

  it("skips slow polling reads but lets manual refresh cancel and retry", async () => {
    mocks.getPluginDiagnostics.mockResolvedValueOnce(
      snapshot("session-a", "first"),
    );
    const initial = props("session-a");
    const { rerender } = render(<PluginDiagnosticsPanel {...initial} />);
    expect(await screen.findByText("first")).toBeDefined();

    let resolveSlow!: (value: PluginDiagnosticsSnapshot) => void;
    mocks.getPluginDiagnostics.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    );
    mocks.getPluginDiagnostics.mockResolvedValueOnce(
      snapshot("session-a", "fresh"),
    );
    vi.useFakeTimers();
    try {
      rerender(<PluginDiagnosticsPanel {...initial} autoRefresh />);
      await act(async () => vi.advanceTimersByTimeAsync(9000));
      expect(mocks.getPluginDiagnostics).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("first")).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Refresh|刷新/ }));
      });
      expect(mocks.getPluginDiagnostics).toHaveBeenCalledTimes(3);
      expect(screen.getByText("fresh")).toBeDefined();
      await act(async () => resolveSlow(snapshot("session-a", "stale")));
      expect(screen.queryByText("stale")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
