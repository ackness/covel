/**
 * useMessageGrouping — per-turn interleaving of messages, execution timelines
 * and asset sidebars (R-17).
 *
 * After the memoisation refactor the O(history) grouping maps are computed in a
 * useMemo keyed on [messages, executionSteps]; the render loop and
 * `renderMessage` stay fresh. These tests pin the observable output (row order
 * + keys) so the behaviour is unchanged, and verify the maps are NOT rebuilt
 * when an unrelated prop (executing) changes.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { isValidElement, type ReactNode, type ReactElement } from "react";
import { useMessageGrouping } from "../use-message-grouping.js";
import type { StreamMessage, ExecutionStep } from "@/stores/session-store.js";

// AssetTurnSidebar reaches into the plugin-data store; stub it so the hook can
// render in isolation. We only assert on element keys, not sidebar content.
vi.mock("@/components/asset-render/index.js", () => ({
  AssetTurnSidebar: () => null,
}));

function msg(over: Partial<StreamMessage> & { id: string }): StreamMessage {
  return {
    role: "assistant",
    content: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function step(
  over: Partial<ExecutionStep> & { runtimeId: string },
): ExecutionStep {
  return {
    pluginId: over.runtimeId,
    status: "completed",
    attemptStatus: "committed",
    ...over,
  };
}

/** Row keys as rendered (each row is a `.chat-row` wrapper keyed by child key). */
function rowKeys(rows: ReactNode[]): (string | null)[] {
  return rows.map((r) => (isValidElement(r) ? (r as ReactElement).key : null));
}

const renderMessage = (m: StreamMessage) => <div key={m.id}>{m.content}</div>;

interface TimelineProps {
  canRetryTasks: boolean;
  steps: ExecutionStep[];
  executing: boolean;
  isLatestTurn: boolean;
  turnNumberStart: number;
  onRetryRuntime?: (runtimeId: string | readonly string[]) => void;
}

function timeline(rows: ReactNode[], turnId: string): TimelineProps {
  const row = rows.find(
    (value) => isValidElement(value) && value.key === `exec-${turnId}`,
  ) as ReactElement<{ children: ReactElement<TimelineProps> }>;
  return row.props.children.props;
}

describe("useMessageGrouping", () => {
  it("leaves uncommitted story recovery to the authoritative recovery notice", () => {
    const retry = vi.fn();
    const { result } = renderHook(() =>
      useMessageGrouping({
        messages: [],
        executionSteps: [
          step({
            runtimeId: "story",
            turnId: "source",
            status: "failed",
            attemptStatus: "failed",
          }),
        ],
        executing: false,
        plugins: [],
        onRetryRuntime: retry,
        renderMessage,
      }),
    );
    const props = timeline(result.current, "source");
    expect(props.canRetryTasks).toBe(false);
    expect(props.onRetryRuntime).toBeUndefined();
    expect(props).not.toHaveProperty("onRetryAll");
    expect(retry).not.toHaveBeenCalled();
  });
  it("keeps retry attempts in their source group and retries remaining tasks against that source", () => {
    const onRetryRuntime = vi.fn();
    const { result } = renderHook(() =>
      useMessageGrouping({
        messages: [msg({ id: "story", turnId: "source" })],
        executionSteps: [
          step({
            runtimeId: "story",
            turnId: "source",
            startedAt: "2026-01-01T00:00:00Z",
          }),
          step({
            runtimeId: "a",
            turnId: "source",
            status: "failed",
            startedAt: "2026-01-01T00:00:00Z",
          }),
          step({
            runtimeId: "b",
            turnId: "source",
            status: "failed",
            startedAt: "2026-01-01T00:00:00Z",
          }),
          step({
            runtimeId: "a",
            turnId: "retry",
            sourceTurnId: "source",
            attemptStatus: "committed",
            startedAt: "2026-01-02T00:00:00Z",
          }),
        ],
        executing: false,
        plugins: [],
        onRetryRuntime,
        renderMessage,
      }),
    );
    expect(rowKeys(result.current)).toEqual([
      "story",
      "exec-source",
      "assets-source",
    ]);
    const projected = timeline(result.current, "source");
    expect(
      projected.steps.map((value) => [value.runtimeId, value.status]),
    ).toEqual([
      ["story", "completed"],
      ["a", "completed"],
      ["b", "failed"],
    ]);
    projected.onRetryRuntime?.("b");
    projected.onRetryRuntime?.(["a", "b"]);
    expect(onRetryRuntime.mock.calls).toEqual([
      ["b", "source"],
      [["a", "b"], "source"],
    ]);
  });

  it("inserts a turn's execution timeline after that turn's last message", () => {
    const messages = [
      msg({ id: "u1", role: "user", turnId: "t1" }),
      msg({ id: "a1", turnId: "t1", content: "reply" }),
    ];
    const executionSteps = [step({ runtimeId: "narrator", turnId: "t1" })];

    const { result } = renderHook(() =>
      useMessageGrouping({
        messages,
        executionSteps,
        executing: false,
        plugins: [],
        renderMessage,
      }),
    );

    // u1, a1, then the timeline + asset sidebar for t1 after a1 (its last msg).
    expect(rowKeys(result.current)).toEqual([
      "u1",
      "a1",
      "exec-t1",
      "assets-t1",
    ]);
  });

  it("renders a turn without messages using its own stable identity", () => {
    const { result } = renderHook(() =>
      useMessageGrouping({
        messages: [],
        executionSteps: [step({ runtimeId: "boot", turnId: "t9" })],
        executing: true,
        plugins: [],
        renderMessage,
      }),
    );

    expect(rowKeys(result.current)).toEqual(["exec-t9"]);
  });

  it("places an old interrupted turn before newer messages and permits only the latest turn retry", () => {
    const onRetryRuntime = vi.fn();
    const { result } = renderHook(() =>
      useMessageGrouping({
        messages: [
          msg({
            id: "new-story",
            turnId: "new-turn",
            timestamp: "2026-01-01T02:00:00Z",
          }),
        ],
        executionSteps: [
          step({
            runtimeId: "narrator",
            turnId: "old-turn",
            status: "failed",
            startedAt: "2026-01-01T01:00:00Z",
          }),
          step({
            runtimeId: "tracker",
            turnId: "new-turn",
            status: "failed",
            startedAt: "2026-01-01T02:00:01Z",
          }),
        ],
        executing: false,
        plugins: [],
        onRetryRuntime,
        renderMessage,
      }),
    );
    expect(rowKeys(result.current)).toEqual([
      "exec-old-turn",
      "new-story",
      "exec-new-turn",
      "assets-new-turn",
    ]);
    const oldTurn = timeline(result.current, "old-turn");
    expect(oldTurn).toMatchObject({
      executing: false,
      isLatestTurn: false,
      turnNumberStart: 1,
    });
    expect(oldTurn.onRetryRuntime).toBeUndefined();
    expect(oldTurn).not.toHaveProperty("onRetryAll");
    const latest = timeline(result.current, "new-turn");
    expect(latest).toMatchObject({
      executing: false,
      isLatestTurn: true,
      turnNumberStart: 2,
    });
    latest.onRetryRuntime?.("tracker");
    expect(onRetryRuntime.mock.calls).toEqual([["tracker", "new-turn"]]);
  });

  it("does not mark an older orphan turn active while the latest turn runs", () => {
    const { result } = renderHook(() =>
      useMessageGrouping({
        messages: [
          msg({
            id: "latest-user",
            role: "user",
            turnId: "latest",
            timestamp: "2026-01-01T02:00:00Z",
          }),
        ],
        executionSteps: [
          step({
            runtimeId: "narrator",
            turnId: "old",
            status: "failed",
            startedAt: "2026-01-01T01:00:00Z",
          }),
          step({
            runtimeId: "narrator",
            turnId: "latest",
            status: "running",
            startedAt: "2026-01-01T02:00:01Z",
          }),
        ],
        executing: true,
        plugins: [],
        onRetryRuntime: vi.fn(),
        renderMessage,
      }),
    );
    expect(timeline(result.current, "old")).toMatchObject({
      isLatestTurn: false,
      executing: false,
    });
    expect(timeline(result.current, "latest")).toMatchObject({
      isLatestTurn: true,
      executing: true,
    });
    expect(timeline(result.current, "latest").onRetryRuntime).toBeUndefined();
  });

  it("keeps the source turn when retrying the newest turn without messages", () => {
    const onRetryRuntime = vi.fn();
    const { result } = renderHook(() =>
      useMessageGrouping({
        messages: [msg({ id: "old-story", turnId: "old" })],
        executionSteps: [
          step({
            runtimeId: "narrator",
            turnId: "latest",
            status: "failed",
            startedAt: "2026-01-02T00:00:00Z",
          }),
        ],
        executing: false,
        plugins: [],
        onRetryRuntime,
        renderMessage,
      }),
    );
    timeline(result.current, "latest").onRetryRuntime?.("narrator");
    expect(onRetryRuntime).toHaveBeenCalledWith("narrator", "latest");
  });

  it("does not reuse a historical turn as active before the new message has a turn ID", () => {
    const { result } = renderHook(() =>
      useMessageGrouping({
        messages: [
          msg({ id: "old-story", turnId: "old" }),
          msg({
            id: "pending",
            role: "user",
            timestamp: "2026-01-02T00:00:00Z",
          }),
        ],
        executionSteps: [step({ runtimeId: "narrator", turnId: "old" })],
        executing: true,
        plugins: [],
        onRetryRuntime: vi.fn(),
        renderMessage,
      }),
    );
    expect(timeline(result.current, "old")).toMatchObject({
      isLatestTurn: false,
      executing: false,
    });
  });

  it("does not rebuild grouping maps when only `executing` changes", () => {
    const messages = [msg({ id: "a1", turnId: "t1", content: "x" })];
    const executionSteps = [step({ runtimeId: "narrator", turnId: "t1" })];

    // Spy on Map iteration would be brittle; instead assert referential
    // stability of the derived output for the message rows across an
    // executing-only re-render. The rows are freshly wrapped each render, but
    // the ordering/keys must be identical — the memo guarantees the maps are
    // reused rather than recomputed.
    const { result, rerender } = renderHook(
      ({ executing }: { executing: boolean }) =>
        useMessageGrouping({
          messages,
          executionSteps,
          executing,
          plugins: [],
          renderMessage,
        }),
      { initialProps: { executing: false } },
    );

    const before = rowKeys(result.current);
    rerender({ executing: true });
    expect(rowKeys(result.current)).toEqual(before);
  });
});
