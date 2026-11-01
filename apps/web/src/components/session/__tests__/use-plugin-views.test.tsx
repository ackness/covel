import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePluginViews } from "../game-view/use-plugin-views.js";
import { viewEntry, sessionPlugin } from "./plugin-view-fixtures.js";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/services/api.js", () => ({ fetchUiSpecs: mocks.fetch }));
afterEach(() => {
  cleanup();
  mocks.fetch.mockReset();
});
it("maps active views, resolves localized names, and shares the sorted discovery key", async () => {
  mocks.fetch.mockResolvedValue({
    right: [],
    view: [
      { pluginId: "p", specs: [viewEntry.spec] },
      { pluginId: "inactive", specs: [viewEntry.spec] },
    ],
  });
  const { result, rerender } = renderHook(
    ({ language }) =>
      usePluginViews(
        "s",
        [sessionPlugin, { ...sessionPlugin, id: "inactive", active: false }],
        language,
      ),
    { initialProps: { language: "en-US" } },
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(result.current.views).toEqual([viewEntry]);
  expect(mocks.fetch).toHaveBeenCalledWith("s", "p");
  rerender({ language: "zh-CN" });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(result.current.views[0]).toMatchObject({
    label: "阅读器",
    pluginName: "示例",
  });
});
it("never reuses another session's list while discovery is loading or failed", async () => {
  mocks.fetch.mockResolvedValueOnce({
    right: [],
    view: [{ pluginId: "p", specs: [viewEntry.spec] }],
  });
  const { result, rerender } = renderHook(
    ({ sessionId }) => usePluginViews(sessionId, [sessionPlugin], "en"),
    { initialProps: { sessionId: "s" } },
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let reject!: (error: Error) => void;
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  rerender({ sessionId: "next" });
  expect(result.current.status).toBe("loading");
  expect(result.current.views).toEqual([]);
  await act(async () => reject(new Error("offline")));
  expect(result.current.status).toBe("error");
  expect(result.current.views).toEqual([]);
});
it("reload refetches the projection and replaces a stale page URL", async () => {
  const spec = {
    ...viewEntry.spec,
    webview: { url: "/plugin-assets/p/old/index.html" },
  };
  mocks.fetch.mockResolvedValueOnce({
    view: [{ pluginId: "p", specs: [spec] }],
  });
  const { result } = renderHook(() =>
    usePluginViews("s", [sessionPlugin], "en"),
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
  mocks.fetch.mockResolvedValueOnce({
    view: [
      {
        pluginId: "p",
        specs: [
          { ...spec, webview: { url: "/plugin-assets/p/new/index.html" } },
        ],
      },
    ],
  });
  await act(async () => {
    await result.current.reload();
  });
  await waitFor(() =>
    expect(result.current.views[0]?.spec.webview?.url).toContain("/new/"),
  );
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it("separates composer declarations from story views and keeps a healthy region available during refresh", async () => {
  const input = {
    ...viewEntry.spec,
    id: "input",
    surface: "composer" as const,
  };
  const main = { ...viewEntry.spec, surface: "main" as const };
  mocks.fetch.mockResolvedValueOnce({
    view: [{ pluginId: "p", specs: [main, input] }],
  });
  const { result } = renderHook(() =>
    usePluginViews("s", [sessionPlugin], "en"),
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(result.current.views.map((entry) => entry.spec.surface)).toEqual([
    "main",
  ]);
  expect(result.current.composers?.map((entry) => entry.spec.surface)).toEqual([
    "composer",
  ]);
  let resolve!: (value: unknown) => void;
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let refreshed!: void | Promise<void>;
  act(() => {
    refreshed = result.current.reload();
  });
  expect(result.current.status).toBe("ready");
  expect(result.current.composers).toHaveLength(1);
  await act(async () => {
    resolve({ view: [{ pluginId: "p", specs: [main, input] }] });
    await refreshed;
  });
});
