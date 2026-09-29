import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

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
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
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
vi.mock("@/lib/appearance", () => ({
  applyAppearance: vi.fn(),
  applyColorScheme: vi.fn(),
}));
vi.mock("@/settings/store", () => ({
  getSettings: mocks.getSettings,
  initSettings: mocks.initSettings,
}));
vi.mock("@/stores/session-store/reducer", () => ({
  configureMessagesWindowCap: vi.fn(),
}));
vi.mock("@/theme-system/storage.js", () => ({ CUSTOM_THEMES_KEY: "themes" }));
vi.mock("@/theme-system/overrides.js", () => ({
  APPEARANCE_TOKENS_KEY: "tokens",
  applyTokenOverrides: vi.fn(),
}));
vi.mock("@/theme-system/registry.js", () => ({
  THEME_SCHEME_KEY: "ui.scheme",
  syncThemeRegistry: vi.fn(),
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

it("waits for a known desktop mode before creating settings, then retries", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  mocks.probeDesktopMode
    .mockResolvedValueOnce("unknown")
    .mockResolvedValueOnce("web");
  mocks.getSettings.mockReturnValue({
    get: (key: string) =>
      key === "ui.locale"
        ? "en-US"
        : key === "ui.chatMessageWindow"
          ? 40
          : "light",
    subscribe: vi.fn(),
  });

  await import("../main.js");
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByText("Check the connection and retry.")).toBeTruthy();
  expect(mocks.initSettings).not.toHaveBeenCalled();
  expect(mocks.getSettings).not.toHaveBeenCalled();

  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByText("App ready")).toBeTruthy());
  expect(mocks.probeDesktopMode).toHaveBeenCalledTimes(2);
  expect(mocks.initSettings).toHaveBeenCalledOnce();
  expect(mocks.getSettings).toHaveBeenCalled();
});
