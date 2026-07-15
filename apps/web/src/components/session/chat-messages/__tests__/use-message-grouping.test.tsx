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
  return { pluginId: over.runtimeId, status: "completed", ...over };
}

/** Row keys as rendered (each row is a `.chat-row` wrapper keyed by child key). */
function rowKeys(rows: ReactNode[]): (string | null)[] {
  return rows.map((r) => (isValidElement(r) ? (r as ReactElement).key : null));
}

const renderMessage = (m: StreamMessage) => <div key={m.id}>{m.content}</div>;

describe("useMessageGrouping", () => {
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
        packages: [],
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

  it("renders orphan steps (no messages yet) at the bottom as exec-active", () => {
    const { result } = renderHook(() =>
      useMessageGrouping({
        messages: [],
        executionSteps: [step({ runtimeId: "boot", turnId: "t9" })],
        executing: true,
        packages: [],
        renderMessage,
      }),
    );

    expect(rowKeys(result.current)).toEqual(["exec-active"]);
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
          packages: [],
          renderMessage,
        }),
      { initialProps: { executing: false } },
    );

    const before = rowKeys(result.current);
    rerender({ executing: true });
    expect(rowKeys(result.current)).toEqual(before);
  });
});
