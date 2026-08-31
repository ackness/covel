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

const { useMessageUiSpecHydrationEffect } = await import("../effects.js");

const messageSpecs = {
  right: [],
  message: [
    {
      pluginId: "scene-prompts",
      specs: [],
    },
  ],
} as UISpecsResponse;

describe("useMessageUiSpecHydrationEffect", () => {
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

    renderHook(() => useMessageUiSpecHydrationEffect("sess-a", dispatch));

    await waitFor(() => {
      expect(pluginStore.loadPluginDataForSession).toHaveBeenCalledWith(
        "sess-a",
        "scene-prompts",
        "message",
        [{ key: "prompts", value: ["Ask about the note"] }],
      );
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "PLUGIN_DATA_CHANGED",
      pluginId: "scene-prompts",
      changes: [
        {
          namespace: "message",
          key: "prompts",
          value: ["Ask about the note"],
          operation: "set",
        },
      ],
    });
  });

  it("clears a cached message namespace when the server has no rows", async () => {
    api.fetchUiSpecs.mockResolvedValue(messageSpecs);
    api.listPluginData.mockResolvedValue([]);

    renderHook(() => useMessageUiSpecHydrationEffect("sess-a", vi.fn()));

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
      ({ sessionId }) => useMessageUiSpecHydrationEffect(sessionId, dispatch),
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
      expect.objectContaining({ type: "PLUGIN_DATA_CHANGED" }),
    );
  });
});
