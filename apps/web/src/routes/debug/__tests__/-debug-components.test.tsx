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
        phase: "playing",
        completedPlayerTurns: 3,
        setupRuntimes: {},
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

  it("keeps zero-seq flow events visible and summarizes the failed location", () => {
    const selectedTurn = turn("turn-zero-seq", [
      { ...traceEvent("turn.started"), id: "turn-start" },
      {
        ...traceEvent("runtime.started", {
          runtimeId: "story/narrator",
          pluginId: "story",
          stage: "narrative",
        }),
        id: "runtime-start",
      },
      {
        ...traceEvent("llm.calling", {
          runtimeId: "story/narrator",
          messages: [{ role: "system", content: "rules" }],
        }),
        id: "prompt-call",
      },
      {
        ...traceEvent("runtime.failed", {
          runtimeId: "story/narrator",
          pluginId: "story",
          error: "Provider request timed out",
        }),
        id: "runtime-failed",
      },
    ]);
    selectedTurn.events = selectedTurn.events.map((event) => ({
      ...event,
      seq: 0,
    }));

    render(
      <TraceTimeline
        selectedSessionId="session-a"
        turns={getVisibleTurns([selectedTurn])}
        loading={false}
        expandedTurns={new Set(["turn-zero-seq"])}
        expandedRuntimes={new Set()}
        filterCategory={null}
        onToggleTurn={vi.fn()}
        onToggleRuntime={vi.fn()}
        onSelectEvent={vi.fn()}
      />,
    );

    expect(screen.getByText("turn.started")).toBeDefined();
    expect(screen.getByText("1 次提示词")).toBeDefined();
    expect(
      screen.getAllByText(/Provider request timed out/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("story · narrative")).toBeDefined();
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

  it("renders current flat prompt payloads with model and tool definitions", () => {
    render(
      <EventDetailPanel
        event={traceEvent("llm.calling", {
          runtimeId: "story/narrator",
          pluginId: "story",
          provider: "openai",
          model: "gpt-test",
          slot: "default",
          attempt: 1,
          messages: [
            { role: "system", content: "SYSTEM RULES: stay in character" },
            { role: "user", content: "USER PROMPT: open the door" },
            {
              role: "assistant",
              content: "Checking first.",
              toolCalls: [
                {
                  id: "call-123",
                  name: "inspect-door",
                  arguments: { target: "door" },
                },
              ],
            },
          ],
          tools: [
            {
              name: "inspect-door",
              description: "Inspect the selected door",
              jsonSchema: { type: "object" },
            },
          ],
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("SYSTEM RULES: stay in character")).toBeDefined();
    expect(screen.getByText("USER PROMPT: open the door")).toBeDefined();
    expect(screen.getByText("openai / gpt-test")).toBeDefined();
    expect(screen.getByText(/可用工具定义/)).toBeDefined();
    expect(screen.getByText("消息内工具调用")).toBeDefined();
    expect(screen.getAllByText(/call-123/).length).toBeGreaterThan(0);
  });

  it("surfaces runtime and tool failures without opening raw payload", () => {
    const failed = traceEvent("runtime.failed", {
      runtimeId: "story/narrator",
      pluginId: "story",
      status: "failed",
      error: "Provider request timed out",
      durationMs: 30001,
    });

    render(<EventDetailPanel event={failed} onClose={vi.fn()} />);

    expect(screen.getByText("错误详情")).toBeDefined();
    expect(screen.getByText("Provider request timed out")).toBeDefined();
    expect(screen.getByText("story/narrator")).toBeDefined();
    expect(screen.getByText("30001ms")).toBeDefined();
  });

  it("reads tool input and legacy nested trace payloads", () => {
    const { rerender } = render(
      <EventDetailPanel
        event={traceEvent("tool.calling", {
          toolName: "inspect",
          arguments: { target: "north-door" },
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/north-door/).length).toBeGreaterThan(0);

    rerender(
      <EventDetailPanel
        event={traceEvent("llm.responded", {
          data: {
            text: "Legacy response text",
            usage: { inputTokens: 4, outputTokens: 2 },
          },
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Legacy response text")).toBeDefined();
  });

  it("pairs tool input and output by toolCallId", () => {
    const calling = traceEvent("tool.calling", {
      runtimeId: "story/tools",
      toolName: "inspect-door",
      toolCallId: "call-paired",
      arguments: JSON.stringify({ target: "north-door" }),
    });
    const completed = traceEvent(
      "tool.completed",
      {
        runtimeId: "story/tools",
        toolName: "inspect-door",
        toolCallId: "call-paired",
        parsedResult: { locked: true },
        durationMs: 1250,
      },
      2,
    );

    render(
      <EventDetailPanel
        event={completed}
        relatedEvents={[calling, completed]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/inspect-door\(\)/).length).toBeGreaterThan(0);
    expect(screen.getByText("输入参数")).toBeDefined();
    expect(screen.getByText("输出结果")).toBeDefined();
    expect(screen.getByText(/north-door/)).toBeDefined();
    expect(screen.getAllByText(/locked/).length).toBeGreaterThan(0);
    expect(screen.getByText(/成功 · 1250ms/)).toBeDefined();
  });
});
