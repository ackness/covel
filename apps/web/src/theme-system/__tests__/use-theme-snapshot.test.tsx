import type { SettingsStoreApi } from "@covel/settings";
import {
  themeStore,
  openTheme,
  themeFixture,
  choiceOf,
} from "./plugin-theme-fixture.js";
const active = vi.hoisted(() => ({
  store: undefined as unknown as SettingsStoreApi,
}));
vi.mock("@/settings/store.js", () => ({ getSettings: () => active.store }));
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { applyAppearance, applyColorScheme } from "@/lib/appearance.js";
import { useThemeSnapshot } from "../use-theme-snapshot.js";

const root = document.documentElement;

afterEach(() => {
  cleanup();
  root.removeAttribute("data-theme");
  root.removeAttribute("data-scheme");
  root.removeAttribute("style");
  root.classList.remove("dark");
});

it("reads the active theme and follows a change of scheme", async () => {
  applyAppearance("book");
  applyColorScheme("light");
  root.style.setProperty("--accent-primary", "rgb(10 20 30)");
  root.style.setProperty("--font-sans", "Inter, sans-serif");
  const { result } = renderHook(() => useThemeSnapshot());
  await waitFor(() => expect(result.current.id).toBe("book"));
  expect(result.current.scheme).toBe("light");
  expect(result.current.tokens.accent).toBe("rgb(10 20 30)");
  expect(result.current.tokens.fontSans).toBe("Inter, sans-serif");
  // Every token is present, as a string, even when the theme leaves it unset.
  expect(
    Object.values(result.current.tokens).every(
      (value) => typeof value === "string",
    ),
  ).toBe(true);

  const before = result.current;
  await act(async () => {
    applyAppearance("paper");
    applyColorScheme("dark");
    root.style.setProperty("--accent-primary", "rgb(200 210 220)");
    await Promise.resolve();
  });
  await waitFor(() => expect(result.current.scheme).toBe("dark"));
  expect(result.current.id).toBe("paper");
  expect(root.classList.contains("dark")).toBe(true);
  expect(result.current.tokens.accent).toBe("rgb(200 210 220)");
  expect(result.current).not.toBe(before);
});

it("projects only a matching session's safe palette and identity while the no-session snapshot stays at the base", async () => {
  const { store } = await themeStore();
  active.store = store;
  const source = await openTheme(store);
  applyAppearance("panel");
  applyColorScheme("dark");
  root.style.setProperty("--accent-primary", "#112233");
  root.style.setProperty("--font-sans", "Host font");
  const theme = {
    ...themeFixture(),
    tokens: { dark: { "--accent-primary": "#abcdef" } },
  };
  source.replace([{ theme, owner: "Author" }], "ready");
  const { result } = renderHook(() => ({
    session: useThemeSnapshot("session-one"),
    other: useThemeSnapshot("session-two"),
    base: useThemeSnapshot(),
  }));
  try {
    await act(async () => {
      await source.select(choiceOf(theme));
    });
    await waitFor(() =>
      expect(result.current.session.tokens.accent).toBe("#abcdef"),
    );
    expect(result.current.base.tokens.accent).toBe("#112233");
    expect(result.current.other.id).toBe("panel");
    expect(result.current.session.tokens.fontSans).toBe("Host font");
    expect(JSON.stringify(result.current.session)).not.toMatch(
      /cssText|paper.png|session-one|contentHash|settings/,
    );
    await act(async () => {
      await source.select(null);
    });
    expect(result.current.session).toEqual(result.current.base);
  } finally {
    source.dispose();
    vi.unstubAllGlobals();
  }
});
