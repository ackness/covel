import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UISpecsResponse } from "@/services/api";

const api = vi.hoisted(() => ({
  fetchUiSpecs: vi.fn(),
  listPluginData: vi.fn(),
}));
const pluginStore = vi.hoisted(() => ({
  loadPluginDataForSession: vi.fn(),
  replacePluginDataForSession: vi.fn(() => true),
}));

vi.mock("@/services/api", () => api);
vi.mock("@/stores/plugin-data-store.js", () => pluginStore);

const { default: i18n } = await import("@/i18n/index.js");
const { useUiSpecHydrationEffect, usePersistExecutionStepsEffect } =
  await import("../effects.js");

const generationRef = { current: 0 };

const messageSpecs = {
  theme: [],
  right: [],
  message: [
    {
      pluginId: "scene-prompts",
      specs: [],
    },
  ],
} as UISpecsResponse;

const activePlugin = (id: string) =>
  ({
    id,
    active: true,
  }) as import("@/services/api").SessionPlugin;

describe("useUiSpecHydrationEffect", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    pluginStore.replacePluginDataForSession.mockReturnValue(true);
    await i18n.changeLanguage("en-US");
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
      sessionId === "sess-a"
        ? messageSpecs
        : { right: [], theme: [], message: [] },
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
      expect(api.fetchUiSpecs).toHaveBeenCalledWith("sess-b", "");
    });

    expect(pluginStore.loadPluginDataForSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "REPLACE_PLUGIN_DATA_NAMESPACE" }),
    );
  });

  it("refreshes localized UI specs on language switch without re-fetching already-hydrated plugin KV data", async () => {
    const localizedSpecs = (label: string): UISpecsResponse => ({
      theme: [],
      right: [{ pluginId: "codex", specs: [{ label }] }],
      message: [{ pluginId: "scene-prompts", specs: [{ label }] }],
      segment: [],
    });
    api.fetchUiSpecs
      .mockResolvedValueOnce(localizedSpecs("English"))
      .mockResolvedValueOnce(localizedSpecs("中文"))
      .mockResolvedValueOnce(localizedSpecs("中文"));
    api.listPluginData.mockResolvedValue([]);
    const dispatch = vi.fn();
    const initialPlugins = [
      activePlugin("codex"),
      activePlugin("scene-prompts"),
    ];

    const { rerender } = renderHook(
      ({ plugins }) =>
        useUiSpecHydrationEffect("sess-a", dispatch, generationRef, plugins),
      { initialProps: { plugins: initialPlugins } },
    );

    await waitFor(() => {
      expect(api.listPluginData).toHaveBeenCalledTimes(2);
    });
    expect(api.listPluginData).toHaveBeenCalledWith("sess-a", "codex");
    expect(api.listPluginData).toHaveBeenCalledWith(
      "sess-a",
      "scene-prompts",
      "message",
    );

    // Switching UI language re-fetches localized specs only, not KV data.
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    await waitFor(() => {
      expect(api.fetchUiSpecs).toHaveBeenCalledTimes(2);
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "LOAD_MESSAGE_UI_SPECS",
      specs: [{ pluginId: "scene-prompts", specs: [{ label: "中文" }] }],
    });
    expect(api.listPluginData).toHaveBeenCalledTimes(2);

    // Changing the active plugin set resets hydration and re-fetches KV data.
    rerender({
      plugins: [
        activePlugin("codex"),
        activePlugin("scene-prompts"),
        activePlugin("extra"),
      ],
    });
    await waitFor(() => {
      expect(api.listPluginData).toHaveBeenCalledTimes(4);
    });
  });

  it("retries plugin KV hydration on language switch if the initial KV fetch failed", async () => {
    api.fetchUiSpecs.mockResolvedValue(messageSpecs);
    api.listPluginData
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockResolvedValueOnce([
        {
          namespace: "message",
          key: "prompts",
          value: ["Recovered"],
          updatedAt: "2026-08-27T00:00:00.000Z",
        },
      ]);
    const dispatch = vi.fn();

    renderHook(() =>
      useUiSpecHydrationEffect("sess-a", dispatch, generationRef, []),
    );

    await waitFor(() => {
      expect(api.listPluginData).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });

    await waitFor(() => {
      expect(pluginStore.loadPluginDataForSession).toHaveBeenCalledWith(
        "sess-a",
        "scene-prompts",
        "message",
        [{ key: "prompts", value: ["Recovered"] }],
      );
    });
    expect(api.listPluginData).toHaveBeenCalledTimes(2);
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
