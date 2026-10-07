import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UISpecsResponse } from "@/services/api";

const api = vi.hoisted(() => ({
  fetchUiSpecs: vi.fn(),
  listPluginData: vi.fn(),
}));
const pluginStore = vi.hoisted(() => ({
  loadPluginDataForSession: vi.fn(),
}));

vi.mock("@/services/api", () => api);
vi.mock("@/stores/plugin-data-store.js", () => pluginStore);

const { useUiSpecHydrationEffect, usePersistExecutionStepsEffect } =
  await import("../effects.js");

const generationRef = { current: 0 };

const messageSpecs = {
  right: [],
  message: [
    {
      pluginId: "scene-prompts",
      specs: [],
    },
  ],
} as UISpecsResponse;

describe("useUiSpecHydrationEffect", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("hydrates message rows into both plugin-data stores", async () => {
    const rows = [
      {
        namespace: "message",
        key: "prompts",
        value: ["Ask about the note"],
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    ];
    api.fetchUiSpecs.mockResolvedValue(messageSpecs);
    api.listPluginData.mockResolvedValue(rows);
    const dispatch = vi.fn();

    renderHook(() =>
      useUiSpecHydrationEffect("sess-a", dispatch, generationRef, []),
    );

    await waitFor(() => {
      expect(pluginStore.loadPluginDataForSession).toHaveBeenCalledWith(
        "sess-a",
        "scene-prompts",
        "message",
        [{ key: "prompts", value: ["Ask about the note"] }],
      );
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "REPLACE_PLUGIN_DATA_NAMESPACE",
      pluginId: "scene-prompts",
      namespace: "message",
      data: { prompts: ["Ask about the note"] },
    });
  });

  it("clears a cached message namespace when the server has no rows", async () => {
    api.fetchUiSpecs.mockResolvedValue(messageSpecs);
    api.listPluginData.mockResolvedValue([]);

    renderHook(() =>
      useUiSpecHydrationEffect("sess-a", vi.fn(), generationRef, []),
    );

    await waitFor(() => {
      expect(pluginStore.loadPluginDataForSession).toHaveBeenCalledWith(
        "sess-a",
        "scene-prompts",
        "message",
        [],
      );
    });
  });

  it("drops message rows that resolve after switching sessions", async () => {
    let releaseRows!: (rows: unknown[]) => void;
    api.fetchUiSpecs.mockImplementation(async (sessionId: string) =>
      sessionId === "sess-a" ? messageSpecs : { right: [], message: [] },
    );
    api.listPluginData.mockReturnValue(
      new Promise((resolve) => {
        releaseRows = resolve;
      }),
    );
    const dispatch = vi.fn();
    const { rerender } = renderHook(
      ({ sessionId }) =>
        useUiSpecHydrationEffect(sessionId, dispatch, generationRef, []),
      { initialProps: { sessionId: "sess-a" } },
    );

    await waitFor(() => {
      expect(api.listPluginData).toHaveBeenCalledWith(
        "sess-a",
        "scene-prompts",
        "message",
      );
    });
    rerender({ sessionId: "sess-b" });
    await act(async () => {
      releaseRows([
        {
          namespace: "message",
          key: "prompts",
          value: ["stale"],
          updatedAt: "2026-08-27T00:00:00.000Z",
        },
      ]);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.fetchUiSpecs).toHaveBeenCalledWith("sess-b");
    });

    expect(pluginStore.loadPluginDataForSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "REPLACE_PLUGIN_DATA_NAMESPACE" }),
    );
  });
});

it("coalesces execution cache writes, bounds history, and flushes on unmount", async () => {
  vi.useFakeTimers();
  try {
    const saveExecutionSteps = vi.fn().mockResolvedValue(undefined);
    const ds = {
      saveExecutionSteps,
    } as unknown as import("@/services/data-service.js").DataService;
    const session = {
      id: "cache-session",
      incarnation: "v1",
    } as import("../types.js").SessionState["session"];
    const steps = Array.from({ length: 510 }, (_, index) => ({
      id: String(index),
      runtimeId: "worker",
      pluginId: "provider",
      status: "completed",
    })) as import("../types.js").SessionState["executionSteps"];
    const { rerender, unmount } = renderHook(
      ({ count }) =>
        usePersistExecutionStepsEffect(
          { session, executionSteps: steps.slice(0, count) },
          ds,
        ),
      { initialProps: { count: 1 } },
    );
    rerender({ count: 400 });
    rerender({ count: 510 });
    expect(saveExecutionSteps).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(saveExecutionSteps).toHaveBeenCalledOnce();
    expect(saveExecutionSteps.mock.calls[0]?.[1]).toEqual(steps.slice(-500));
    rerender({ count: 509 });
    unmount();
    expect(saveExecutionSteps).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveExecutionSteps).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
