import { act, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@covel/settings";
import * as appearance from "@/lib/appearance.js";
import { CUSTOM_THEMES_KEY } from "@/theme-system/storage.js";
import { APPEARANCE_TOKENS_KEY } from "@/theme-system/overrides.js";

const mocks = vi.hoisted(() => ({
  probeDesktopMode: vi.fn(),
  initSettings: vi.fn(async () => undefined),
  getSettings: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createRouter: () => ({}),
  RouterProvider: () => <div>App ready</div>,
}));
vi.mock("../routeTree.gen", () => ({ routeTree: {} }));
vi.mock("@/components/reload-overlay", () => ({ ReloadOverlay: () => null }));
vi.mock("@/stores/session-store", () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/services/data-service", () => ({
  setStorageMode: vi.fn(),
  storageModeForServerStorage: () => null,
}));
vi.mock("@/services/api", () => ({
  fetchServerHealth: vi.fn(async () => ({ storage: "sqlite" })),
}));
vi.mock("@/lib/desktop-bridge", () => ({
  probeDesktopMode: mocks.probeDesktopMode,
}));
vi.mock("@/settings/store", () => ({
  getSettings: mocks.getSettings,
  initSettings: mocks.initSettings,
}));
vi.mock("@/stores/session-store/reducer", () => ({
  configureMessagesWindowCap: vi.fn(),
}));
vi.mock("@/i18n", () => ({
  default: {
    language: "en-US",
    changeLanguage: vi.fn(async () => undefined),
    t: (key: string) =>
      ({
        "error.boot.title": "Failed to start",
        "error.boot.desktopModeUnavailable": "Check the connection and retry.",
        "error.boot.retry": "Retry",
      })[key] ?? key,
  },
  i18nReady: Promise.resolve(),
}));

it("initializes browser settings when server management discovery is unavailable", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  mocks.probeDesktopMode.mockResolvedValueOnce("unknown");
  const save = vi.fn().mockRejectedValue(new Error("read only"));
  const store = new SettingsStore({
    load: async () => ({
      "ui.locale": "en-US",
      "ui.chatMessageWindow": 40,
      "ui.appearance": "missing-theme",
      "ui.scheme": "light",
      [APPEARANCE_TOKENS_KEY]: {
        shared: {},
        light: { "--story-color": "#aaaaaa" },
        dark: { "--story-color": "#bbbbbb" },
      },
    }),
    save,
    loadSecrets: async () => ({}),
    saveSecrets: async () => undefined,
  });
  await store.init();
  mocks.getSettings.mockReturnValue(store);
  const applyAppearance = vi.spyOn(appearance, "applyAppearance");
  const applyColorScheme = vi.spyOn(appearance, "applyColorScheme");
  const root = document.documentElement;
  function expectDisplayed(id: string, scheme: appearance.ColorScheme) {
    expect(applyAppearance).toHaveBeenLastCalledWith(id);
    expect(applyColorScheme).toHaveBeenLastCalledWith(scheme);
    expect(root.dataset.theme).toBe(id);
    expect(root.dataset.scheme).toBe(scheme);
    expect(root.style.colorScheme).toBe(scheme);
    expect(root.classList.contains("dark")).toBe(scheme === "dark");
    expect(root.style.getPropertyValue("--story-color")).toBe(
      scheme === "dark" ? "#bbbbbb" : "#aaaaaa",
    );
  }

  await import("../main.js");
  expect(await screen.findByText("App ready")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  // Boot must keep the resolved fallback instead of reapplying raw preferences.
  expectDisplayed("stage", "dark");
  expect(store.get("ui.appearance")).toBe("missing-theme");
  expect(store.get("ui.scheme")).toBe("light");
  expect(save).not.toHaveBeenCalled();
  expect(applyAppearance.mock.calls).toEqual([["stage"]]);
  expect(applyColorScheme.mock.calls).toEqual([["dark"]]);

  save.mockResolvedValue(undefined);
  await act(() => store.set("ui.appearance", "paper"));
  expectDisplayed("paper", "light");
  await act(() => store.set("ui.scheme", "dark"));
  expectDisplayed("paper", "dark");
  await act(() => store.set("ui.appearance", "abyss"));
  applyColorScheme.mockClear();
  await act(() => store.set("ui.scheme", "light"));
  expectDisplayed("abyss", "dark");
  expect(store.get("ui.scheme")).toBe("light");
  expect(applyColorScheme.mock.calls).toEqual([["dark"]]);

  await act(() =>
    store.set(CUSTOM_THEMES_KEY, [
      {
        id: "daylight",
        label: "Daylight",
        schemes: ["light"],
        cssText: 'html[data-theme="daylight"] { --color-background: #ffffff; }',
      },
    ]),
  );
  await act(() => store.set("ui.appearance", "daylight"));
  expectDisplayed("daylight", "light");
  await act(() => store.set(CUSTOM_THEMES_KEY, []));
  expectDisplayed("stage", "dark");
  expect(store.get("ui.appearance")).toBe("daylight");
  expect(store.get("ui.scheme")).toBe("light");

  await act(() =>
    store.set(APPEARANCE_TOKENS_KEY, {
      shared: {},
      light: { "--story-color": "#cccccc" },
      dark: { "--story-color": "#dddddd" },
    }),
  );
  expect(root.style.getPropertyValue("--story-color")).toBe("#dddddd");
  expect(mocks.probeDesktopMode).toHaveBeenCalledOnce();
  expect(mocks.initSettings).toHaveBeenCalledOnce();
  expect(mocks.getSettings).toHaveBeenCalled();
});
