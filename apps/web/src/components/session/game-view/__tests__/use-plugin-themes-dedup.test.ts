import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettingsStoreApi } from "@covel/settings";
import type { SessionPlugin, UISpecsResponse } from "@/services/api.js";
import { fetchUiSpecs } from "@/services/api/plugin-data.js";
import { usePluginThemes } from "../use-plugin-themes.js";
import {
  themeFixture,
  themeStore,
} from "@/theme-system/__tests__/plugin-theme-fixture.js";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown as SettingsStoreApi,
  request: vi.fn(),
  i18n: { language: "en-US", t: (key: string) => key },
}));

vi.mock("@/settings/use-settings.js", () => ({
  useSettingsStore: () => mocks.store,
}));
vi.mock("@/services/api/request.js", () => ({
  request: (...args: unknown[]) => mocks.request(...args),
}));
vi.mock("@/i18n/index.js", () => ({
  default: mocks.i18n,
}));

function makePlugin(id: string, active = true): SessionPlugin {
  return {
    id,
    displayName: { en: id },
    description: id,
    active,
    executionMode: "declarative",
    kind: "plugin",
    source: "community",
    hostState: "loaded",
    runtimeCount: 0,
    provides: [],
    requires: [],
    optional: [],
    conflicts: [],
    extensions: [],
    tools: [],
    runtimes: [],
    eventTopics: [],
    tags: [],
    userSettings: [],
    languages: { text: ["en"], instructions: ["en"] },
    serverCodeApproved: true,
    sessionState: active ? "active" : "inactive",
    locked: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.request.mockReset();
  mocks.i18n.language = "en-US";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shares the in-flight /api/ui-specs request with other callers using activePluginKey", async () => {
  const { store } = await themeStore();
  mocks.store = store;
  const pending = deferred<UISpecsResponse>();
  mocks.request.mockReturnValue(pending.promise);

  const plugins = [
    makePlugin("zeta"),
    makePlugin("reading-pack"),
    makePlugin("inactive", false),
  ];
  const activePluginKey = "reading-pack\u001fzeta";
  const peerRead = fetchUiSpecs("session-dedup", activePluginKey);

  const { result } = renderHook(() =>
    usePluginThemes("session-dedup", plugins, "en-US"),
  );

  await waitFor(() => expect(result.current.source).toBeDefined());
  expect(mocks.request).toHaveBeenCalledTimes(1);

  const theme = themeFixture("reading");
  const payload: UISpecsResponse = {
    right: [],
    theme: [{ pluginId: "reading-pack", specs: [theme] }],
  };
  await act(async () => {
    pending.resolve(payload);
    await peerRead;
  });

  await waitFor(() =>
    expect(result.current.source?.state.status).toBe("ready"),
  );
  expect(result.current.source?.state.packs).toHaveLength(1);
});

it("still discards stale results after switching sessions while deduplicating activePluginKey", async () => {
  const { store } = await themeStore();
  mocks.store = store;
  const first = deferred<UISpecsResponse>();
  const second = deferred<UISpecsResponse>();
  mocks.request
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  const plugins = [makePlugin("reading-pack")];
  const { result, rerender } = renderHook(
    ({ sessionId }) => usePluginThemes(sessionId, plugins, "en-US"),
    { initialProps: { sessionId: "session-a" } },
  );

  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
  rerender({ sessionId: "session-b" });
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));

  await act(async () => {
    second.resolve({ right: [], theme: [] });
    await second.promise;
  });
  await waitFor(() =>
    expect(result.current.source?.state.status).toBe("ready"),
  );

  await act(async () => {
    first.resolve({
      right: [],
      theme: [{ pluginId: "reading-pack", specs: [themeFixture()] }],
    });
    await first.promise;
  });
  expect(result.current.source?.state.packs).toEqual([]);
});
