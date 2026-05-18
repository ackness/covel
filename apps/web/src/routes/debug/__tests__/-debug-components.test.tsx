import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { SessionSnapshot } from "@covel/shared";
import type * as api from "@/services/api.js";
import { DebugToolbar } from "../-debug-toolbar.js";
import { EventDetailPanel } from "../-event-detail-panel.js";
import { getVisibleTurns } from "../-debug-page-model.js";
import { SessionDataView } from "../-session-data-view.js";
import { TraceTimeline } from "../-trace-timeline.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function traceEvent(
  type: string,
  payload: Record<string, unknown> = {},
  seq = 1,
): api.TraceEvent {
  return {
    type,
    requestId: "req",
    traceId: "trace",
    sessionId: "session-a",
    turnId: "turn-a",
    flowId: "flow-a",
    seq,
    timestamp: "2026-05-11T00:00:00.000Z",
    payload,
  };
}

function turn(turnId: string, events: api.TraceEvent[]): api.TurnTrace {
  return {
    turnId,
    flowId: `flow-${turnId}`,
    traceId: `trace-${turnId}`,
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:00:01.250Z",
    eventCount: events.length,
    events: events.map((event, index) => ({
      ...event,
      turnId,
      seq: index + 1,
    })),
  };
}

describe("debug route components", () => {
  it("switches toolbar views and emits category changes", () => {
    const onDebugViewChange = vi.fn();
    const onFilterCategoryChange = vi.fn();

    render(
      <DebugToolbar
        debugView="traces"
        filterCategory={null}
        onDebugViewChange={onDebugViewChange}
        onFilterCategoryChange={onFilterCategoryChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "会话数据" }));
    expect(onDebugViewChange).toHaveBeenCalledWith("data");

    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    expect(onFilterCategoryChange).toHaveBeenCalledWith("tool");
  });

  it("renders snapshot data and trace discovery without route state", () => {
    const snapshot: SessionSnapshot = {
      session: {
        id: "session-data",
        worldId: "world-1",
        turnCount: 3,
        locale: "zh-CN",
      },
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "The door opens.",
          runtimeId: "story/runtime",
          createdAt: "2026-05-11T00:00:00.000Z",
        },
      ],
      characters: [
        {
          id: "character-1",
          name: "Mira",
          type: "npc",
          description: "Archivist",
          fields: { courage: 3 },
        },
      ],
      gameState: { location: "archive" },
      executionSteps: [
        {
          type: "runtime.completed",
          turnId: "turn-1",
          payload: { runtimeId: "story/runtime", durationMs: 42 },
          timestamp: "2026-05-11T00:00:00.000Z",
        },
      ],
      plugins: [],
    };
    const discovery: api.TraceDiscovery = {
      framework: {
        pluginManifest: { triggerTypes: ["auto"], outputKinds: ["story"] },
        pluginData: { scope: "session", writePaths: ["plugin.data"] },
        tools: { builtin: ["plugin-data-set"] },
        worldData: { sourceKinds: ["json"], mergeModes: ["replace"] },
      },
      plugins: [
        {
          id: "story-plugin",
          name: "Story Plugin",
          capabilities: ["narrative"],
          tools: { builtin: ["append-story"] },
          ui: { right: [{ runtimeId: "story/runtime", path: "ui.json" }] },
        },
      ],
      pluginData: [
        {
          pluginId: "story-plugin",
          namespaces: [
            {
              namespace: "state",
              count: 1,
              keys: [
                {
                  key: "chapter",
                  createdAt: "2026-05-11T00:00:00.000Z",
                  updatedAt: "2026-05-11T00:00:00.000Z",
                  valueType: "string",
                },
              ],
            },
          ],
        },
      ],
    };

    render(
      <SessionDataView
        selectedSessionId="session-data"
        snapshotData={snapshot}
        traceDiscovery={discovery}
      />,
    );

    expect(screen.getByText("Mira")).toBeDefined();
    expect(screen.getByText("The door opens.")).toBeDefined();
    expect(screen.getAllByText("story-plugin").length).toBeGreaterThan(0);
    expect(screen.getByText("chapter")).toBeDefined();
    expect(screen.getByText(/archive/)).toBeDefined();
  });

  it("renders trace rows and forwards selected events", () => {
    const onSelectEvent = vi.fn();
    const selectedTurn = turn("turn-a", [
      traceEvent("turn.started", {}, 1),
      traceEvent(
        "tool.completed",
        { label: "inspect", data: { result: "locked" } },
        2,
      ),
    ]);

    render(
      <TraceTimeline
        selectedSessionId="session-a"
        turns={getVisibleTurns([selectedTurn])}
        loading={false}
        expandedTurns={new Set(["turn-a"])}
        expandedRuntimes={new Set()}
        filterCategory={null}
        onToggleTurn={vi.fn()}
        onToggleRuntime={vi.fn()}
        onSelectEvent={onSelectEvent}
      />,
    );

    const eventButton = screen.getByText("tool.completed").closest("button");
    expect(eventButton).toBeTruthy();
    fireEvent.click(eventButton!);

    expect(onSelectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool.completed" }),
    );
  });

  it("renders event detail payloads and closes the detail panel", () => {
    const onClose = vi.fn();

    render(
      <EventDetailPanel
        event={traceEvent("tool.calling", {
          detail: JSON.stringify({ target: "door" }),
        })}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("tool.calling")).toBeDefined();
    expect(screen.getAllByText(/target/).length).toBeGreaterThan(0);
    fireEvent.click(
      within(screen.getByText("事件详情").parentElement!).getByText("关闭"),
    );

    expect(onClose).toHaveBeenCalledOnce();
  });
});
