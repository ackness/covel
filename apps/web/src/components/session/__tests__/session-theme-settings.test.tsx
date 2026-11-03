import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsStoreApi } from "@covel/settings";
import type { SessionPlugin, UISpecsResponse } from "@/services/api.js";
import { SessionThemeSettings } from "../session-theme-settings.js";
import { SessionRecoveryControls } from "../session-recovery-controls.js";
import { usePluginThemes } from "../game-view/use-plugin-themes.js";
import {
  PluginThemeSession,
  sessionThemeKey,
} from "@/theme-system/plugin-themes.js";
import {
  themeStore,
  openTheme,
  themeFixture,
  choiceOf,
} from "@/theme-system/__tests__/plugin-theme-fixture.js";
const state = vi.hoisted(() => ({
  store: undefined as unknown as SettingsStoreApi,
  fetch: vi.fn(),
}));
vi.mock("@/settings/use-settings.js", () => ({
  useSettingsStore: () => state.store,
}));
vi.mock("@/services/api.js", () => ({
  fetchUiSpecs: (...args: unknown[]) => state.fetch(...args),
}));
const sources: PluginThemeSession[] = [];
afterEach(() => {
  cleanup();
  for (const source of sources.splice(0)) source.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.fetch.mockReset();
});
const noPlugins: SessionPlugin[] = [];
const plugins: SessionPlugin[] = [
  {
    id: "reading-pack",
    displayName: { en: "Reading author", zh: "阅读作者" },
    description: "Reading",
    active: true,
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
    sessionState: "active",
    locked: false,
  },
];
const response = (theme = themeFixture()): UISpecsResponse => ({
  right: [],
  theme: [{ pluginId: theme.pluginId, specs: [theme] }],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function show(source: PluginThemeSession, onReload = () => {}) {
  render(
    <>
      <SessionThemeSettings source={source} onReload={onReload} />
      <SessionRecoveryControls theme={source} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "会话主题" }));
}
it("leaves a sole pack off and lists its label and owner before saving and clearing the session identity", async () => {
  const { store } = await themeStore();
  state.store = store;
  const source = await openTheme(store);
  sources.push(source);
  show(source);
  expect(
    screen.getByRole("option", { name: "Reading room · Reading author" }),
  ).toBeDefined();
  expect(source.state.effective).toBeNull();
  fireEvent.change(screen.getByRole("combobox"), {
    target: {
      value: JSON.stringify([
        "reading-pack",
        "reading",
        themeFixture().contentHash,
      ]),
    },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "应用" })),
  );
  expect(source.state.effective?.themeId).toBe("reading");
  expect(store.get(sessionThemeKey("session-one"))).toEqual(
    choiceOf(themeFixture()),
  );
  expect(
    screen
      .getByTestId("session-recovery-controls")
      .closest("[data-covel-theme-part]"),
  ).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "使用默认外观" })),
  );
  expect(source.state.effective).toBeNull();
  expect(store.has(sessionThemeKey("session-one"))).toBe(false);
});
it("retains the selection draft after failed persistence and keeps recovery enabled during a pending selection", async () => {
  const { store, save } = await themeStore();
  state.store = store;
  const source = await openTheme(store);
  sources.push(source);
  show(source);
  fireEvent.change(screen.getByRole("combobox"), {
    target: {
      value: JSON.stringify([
        "reading-pack",
        "reading",
        themeFixture().contentHash,
      ]),
    },
  });
  save.mockRejectedValueOnce(new Error("disk full"));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "应用" })),
  );
  expect(source.state.effective).toBeNull();
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toContain(
    "reading",
  );
  expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  const gate = deferred<void>();
  save.mockImplementationOnce(() => gate.promise);
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  await waitFor(() => expect(source.state.saving).toBe(true));
  expect(
    (screen.getByRole("button", { name: "使用默认外观" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "使用默认外观" }));
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  await waitFor(() => expect(source.state.saving).toBe(false));
  expect(source.state.effective).toBeNull();
});
it("shows read-only hydration and never writes from an unhydrated settings store", async () => {
  const { store } = await themeStore();
  state.store = store;
  vi.spyOn(store, "isHydrated").mockReturnValue(false);
  const source = await openTheme(store);
  sources.push(source);
  show(source);
  expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(
    true,
  );
  expect(screen.getByRole("status").textContent).toContain("不能保存");
  expect(await source.select(choiceOf(themeFixture()))).toBe(false);
});
it("ignores a delayed fetch from another session and an old disposer cannot remove the current style", async () => {
  const { store } = await themeStore();
  state.store = store;
  const first = deferred<UISpecsResponse>();
  state.fetch.mockReturnValueOnce(first.promise).mockResolvedValue(response());
  const { result, rerender, unmount } = renderHook(
    ({ session }) => usePluginThemes(session, plugins, "zh-CN"),
    { initialProps: { session: "session-one" } },
  );
  await waitFor(() => expect(result.current.source).toBeDefined());
  const old = result.current.source!;
  rerender({ session: "session-two" });
  await waitFor(() =>
    expect(result.current.source?.state.status).toBe("ready"),
  );
  const current = result.current.source!;
  await act(async () => {
    await current.select(choiceOf(themeFixture()));
  });
  await act(async () => {
    first.resolve(response());
    await first.promise;
    old.dispose();
  });
  expect(current.state.effective?.themeId).toBe("reading");
  expect(
    document.querySelectorAll("style[data-plugin-theme-style]"),
  ).toHaveLength(1);
  expect(
    document.querySelector("style[data-plugin-theme-style]")!.textContent,
  ).toContain(current.scope);
  unmount();
  expect(document.querySelector("style[data-plugin-theme-style]")).toBeNull();
});
it("retires an active source immediately on active-set refresh and keeps changed hashes inactive", async () => {
  const { store } = await themeStore();
  state.store = store;
  state.fetch.mockResolvedValue(response());
  const { result, rerender } = renderHook(
    ({ active }) =>
      usePluginThemes("session-one", active ? plugins : noPlugins, "zh-CN"),
    { initialProps: { active: true } },
  );
  await waitFor(() =>
    expect(result.current.source?.state.status).toBe("ready"),
  );
  await act(async () => {
    await result.current.source!.select(choiceOf(themeFixture()));
  });
  expect(result.current.source?.state.effective).not.toBeNull();
  state.fetch.mockResolvedValue(
    response(themeFixture("reading", "c".repeat(64))),
  );
  act(() => result.current.reload());
  expect(document.querySelector("style[data-plugin-theme-style]")).toBeNull();
  await waitFor(() =>
    expect(result.current.source?.state.status).toBe("ready"),
  );
  expect(result.current.source?.state.effective).toBeNull();
  rerender({ active: false });
  await waitFor(() => expect(result.current.source?.state.packs).toEqual([]));
});
it("keeps the theme when the plugin list reloads with the same activations", async () => {
  const { store } = await themeStore();
  state.store = store;
  state.fetch.mockResolvedValue(response());
  const { result, rerender } = renderHook(
    ({ list }) => usePluginThemes("session-one", list, "zh-CN"),
    { initialProps: { list: plugins } },
  );
  await waitFor(() =>
    expect(result.current.source?.state.status).toBe("ready"),
  );
  await act(async () => {
    await result.current.source!.select(choiceOf(themeFixture()));
  });
  const effective = result.current.source?.state.effective;
  expect(effective).not.toBeNull();
  expect(state.fetch).toHaveBeenCalledTimes(1);
  // A reload after a turn hands over a new array with the same plugins.
  rerender({ list: plugins.map((plugin) => ({ ...plugin })) });
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(result.current.source?.state.effective).toBe(effective);
});
it("keeps Off blocked when its save fails and a delayed theme response arrives", async () => {
  const { store, save } = await themeStore();
  state.store = store;
  state.fetch.mockResolvedValue(response());
  const { result } = renderHook(() =>
    usePluginThemes("session-one", plugins, "zh-CN"),
  );
  await waitFor(() =>
    expect(result.current.source?.state.status).toBe("ready"),
  );
  await act(async () => {
    await result.current.source!.select(choiceOf(themeFixture()));
  });
  save.mockRejectedValueOnce(new Error("conflict"));
  await act(async () => {
    await result.current.source!.select(null);
  });
  act(() => result.current.reload());
  await waitFor(() =>
    expect(result.current.source?.state.status).toBe("ready"),
  );
  expect(result.current.source?.state.effective).toBeNull();
  expect(result.current.source?.state.error).toBe("off-save");
});

it("keeps default appearance reachable while an active selection awaits refreshed discovery", async () => {
  const { store } = await themeStore();
  state.store = store;
  const source = await openTheme(store);
  sources.push(source);
  await source.select(choiceOf(themeFixture()));
  show(source);
  act(() => source.replace([], "loading"));
  expect(source.state.effective).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "使用默认外观" })),
  );
  act(() =>
    source.replace([{ theme: themeFixture(), owner: "Author" }], "ready"),
  );
  expect(source.state.effective).toBeNull();
  expect(store.has(sessionThemeKey("session-one"))).toBe(false);
});

it("retries from the menu and keeps reset authoritative while the discovery read is pending", async () => {
  const { store } = await themeStore();
  state.store = store;
  state.fetch.mockResolvedValue(response());
  const { result } = renderHook(() =>
    usePluginThemes("session-one", plugins, "zh-CN"),
  );
  await waitFor(() =>
    expect(result.current.source?.state.status).toBe("ready"),
  );
  const source = result.current.source!;
  await act(async () => source.select(choiceOf(themeFixture())));
  show(source, () => result.current.reload());
  const pending = deferred<UISpecsResponse>();
  state.fetch.mockReturnValueOnce(pending.promise);
  const reads = state.fetch.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: /^重试$/ }));
  await waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(reads + 1));
  expect(source.state.status).toBe("loading");
  expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(
    true,
  );
  const reset = screen.getByRole("button", { name: "使用默认外观" });
  expect((reset as HTMLButtonElement).disabled).toBe(false);
  await act(async () => fireEvent.click(reset));
  expect(store.has(sessionThemeKey("session-one"))).toBe(false);
  await act(async () => {
    pending.resolve(response());
    await pending.promise;
  });
  await waitFor(() => expect(source.state.status).toBe("ready"));
  expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(
    false,
  );
  expect(source.state.effective).toBeNull();
  expect(document.querySelector("style[data-plugin-theme-style]")).toBeNull();
});
