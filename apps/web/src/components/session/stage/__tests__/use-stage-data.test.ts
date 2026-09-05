import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listPluginData,
  type PluginDataEntry,
} from "@/services/api/plugin-data.js";
import {
  __clearAllPluginDataForTest,
  applyChanges,
  setActiveSession,
} from "@/stores/plugin-data-store.js";
import { useStageData, useStageNamespace } from "../use-stage-data.js";

vi.mock("@/services/api/plugin-data.js", () => ({ listPluginData: vi.fn() }));

afterEach(() => {
  cleanup();
  __clearAllPluginDataForTest();
  vi.resetAllMocks();
});

function row(value: unknown): PluginDataEntry {
  return {
    namespace: "dialogue",
    key: "turn-1",
    value,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("stage data restore without a sidebar", () => {
  it("hydrates the dialogue namespace through the capability provider", async () => {
    const value = {
      schemaVersion: 1,
      turnId: "turn-1",
      paragraphSpeakers: [null],
    };
    vi.mocked(listPluginData).mockResolvedValue([row(value)]);
    setActiveSession("session-1");
    const { result } = renderHook(() => {
      const initial = useStageData("session-1", [
        "custom-stage",
        "custom-stage",
        "",
      ]);
      return useStageNamespace(initial, "custom-stage", "dialogue");
    });
    await waitFor(() => expect(result.current["turn-1"]).toEqual(value));
    expect(listPluginData).toHaveBeenCalledExactlyOnceWith(
      "session-1",
      "custom-stage",
    );
  });

  it("keeps live data when an older initial request finishes later", async () => {
    let resolveFetch!: (rows: PluginDataEntry[]) => void;
    vi.mocked(listPluginData).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    setActiveSession("session-1");
    const { result } = renderHook(() => {
      const initial = useStageData("session-1", ["custom-stage"]);
      return useStageNamespace(initial, "custom-stage", "dialogue");
    });
    act(() =>
      applyChanges("custom-stage", [
        {
          namespace: "dialogue",
          key: "turn-1",
          value: "new",
          operation: "set",
        },
      ]),
    );
    await act(async () => {
      resolveFetch([row("old")]);
    });
    expect(result.current["turn-1"]).toBe("new");
  });

  it("drops an old session's pending response after switching sessions", async () => {
    let resolveOld!: (rows: PluginDataEntry[]) => void;
    vi.mocked(listPluginData).mockImplementation((sessionId) =>
      sessionId === "session-1"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve([row("session-2")]),
    );
    const { result, rerender } = renderHook(
      ({ sessionId }) => useStageData(sessionId, ["custom-stage"]),
      {
        initialProps: { sessionId: "session-1" },
      },
    );
    rerender({ sessionId: "session-2" });
    await waitFor(() =>
      expect(result.current["custom-stage"]?.dialogue?.["turn-1"]).toBe(
        "session-2",
      ),
    );
    await act(async () => {
      resolveOld([row("session-1")]);
    });
    expect(result.current["custom-stage"]?.dialogue?.["turn-1"]).toBe(
      "session-2",
    );
  });
});
