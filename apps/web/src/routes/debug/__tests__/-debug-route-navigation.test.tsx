import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugRoutePage } from "../-debug-route-page.js";

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("../-debug-page-data.js", async () => {
  const { useState } = await import("react");
  return {
    useDebugPageData: (sid: string, view?: string) => {
      const [debugView, setDebugView] = useState(view ?? "traces");
      return {
        sessions: [],
        selectedSessionId: sid,
        visibleTurns: [],
        loading: false,
        refreshing: false,
        autoRefresh: false,
        filterCategory: null,
        expandedTurns: new Set(),
        expandedRuntimes: new Set(),
        selectedEvent: null,
        debugView,
        snapshotData: null,
        snapshotLoading: false,
        snapshotError: false,
        snapshotUpdatedAt: null,
        execution: undefined,
        traceDiscovery: null,
        totalEvents: 0,
        storyTurnCount: 0,
        isPartial: false,
        loadingOlder: false,
        selectSession: vi.fn(),
        openSelectedSession: vi.fn(),
        refresh: vi.fn(),
        loadOlder: vi.fn(),
        loadAll: vi.fn(),
        setAutoRefresh: vi.fn(),
        setFilterCategory: vi.fn(),
        setSelectedEvent: vi.fn(),
        setDebugView,
        toggleTurn: vi.fn(),
        toggleRuntime: vi.fn(),
      };
    },
  };
});
vi.mock("../-session-sidebar.js", () => ({ SessionSidebar: () => null }));
vi.mock("../-plugin-diagnostics-panel.js", () => ({
  PluginDiagnosticsPanel: () => <div data-testid="plugins-panel" />,
}));
vi.mock("../-session-data-view.js", () => ({
  SessionDataView: () => <div data-testid="data-panel" />,
}));
vi.mock("../-cost-panel.js", () => ({
  CostPanel: () => <div data-testid="cost-panel" />,
}));
vi.mock("../-trace-timeline.js", () => ({
  TraceTimeline: () => <div data-testid="traces-panel" />,
}));
vi.mock("../-event-detail-panel.js", () => ({ EventDetailPanel: () => null }));

afterEach(() => {
  cleanup();
  mocks.navigate.mockClear();
});

describe("debug route navigation", () => {
  it("keeps the requested data and cost tab when leaving plugins", () => {
    const { rerender } = render(
      <DebugRoutePage sid="session-a" view="plugins" />,
    );
    expect(screen.getByTestId("plugins-panel")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "会话数据" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/debug",
      search: { sid: "session-a", view: "data", pluginId: undefined },
    });
    rerender(<DebugRoutePage sid="session-a" view="data" />);
    expect(screen.getByTestId("data-panel")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "成本" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/debug",
      search: { sid: "session-a", view: "cost", pluginId: undefined },
    });
    rerender(<DebugRoutePage sid="session-a" view="cost" />);
    expect(screen.getByTestId("cost-panel")).toBeDefined();
  });

  it("restores tabs from URL changes such as browser Back", () => {
    const { rerender } = render(<DebugRoutePage sid="session-a" view="data" />);
    fireEvent.click(screen.getByRole("button", { name: "插件" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/debug",
      search: { sid: "session-a", view: "plugins", pluginId: undefined },
    });
    rerender(<DebugRoutePage sid="session-a" view="plugins" />);
    expect(screen.getByTestId("plugins-panel")).toBeDefined();
    rerender(<DebugRoutePage sid="session-a" view="data" />);
    expect(screen.getByTestId("data-panel")).toBeDefined();
    rerender(<DebugRoutePage sid="session-a" />);
    expect(screen.getByTestId("traces-panel")).toBeDefined();
  });
});
