import { beforeEach, describe, expect, it } from "vitest";
import { SettingsStore, type SettingsBackendAdapter } from "@covel/settings";
import { applyAppearance } from "@/lib/appearance.js";
import {
  deleteCustomTheme,
  getRegisteredThemes,
  primeThemeRegistry,
  saveCustomTheme,
  syncThemeRegistry,
  THEME_SCHEME_KEY,
} from "../registry.js";
import { CUSTOM_THEMES_KEY } from "../storage.js";

class MemorySettingsAdapter implements SettingsBackendAdapter {
  private entries: Record<string, unknown> = {};
  private secrets: Record<string, string> = {};

  async load(): Promise<Record<string, unknown>> {
    return { ...this.entries };
  }

  async save(entries: Record<string, unknown>): Promise<void> {
    this.entries = { ...entries };
  }

  async loadSecrets(): Promise<Record<string, string>> {
    return { ...this.secrets };
  }

  async saveSecrets(keys: Record<string, string>): Promise<void> {
    this.secrets = { ...keys };
  }
}

async function createStore(): Promise<SettingsStore> {
  const store = new SettingsStore(new MemorySettingsAdapter());
  await store.init();
  primeThemeRegistry(store);
  return store;
}

describe("theme registry", () => {
  beforeEach(() => {
    document.head
      .querySelectorAll("style[data-theme-style]")
      .forEach((node) => node.remove());
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-scheme");
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });

  it("hydrates builtin themes and mounts their css", async () => {
    const store = await createStore();
    const themes = syncThemeRegistry(store);

    expect(themes.map((theme) => theme.id)).toEqual([
      "paper",
      "modern",
      "abyss",
      "aurora",
    ]);
    expect(
      document.head.querySelector('style[data-theme-style="paper"]'),
    ).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-scheme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("registers imported custom themes and removes them cleanly", async () => {
    const store = await createStore();

    await saveCustomTheme(
      store,
      {
        id: "ember",
        label: "Ember",
        source: "custom",
        schemes: ["light", "dark"],
        cssText: 'html[data-theme="ember"] { --color-background: #1f1512; }',
      },
      "ember.css",
    );

    expect(getRegisteredThemes().some((theme) => theme.id === "ember")).toBe(
      true,
    );
    expect(store.get(CUSTOM_THEMES_KEY)).toBeTruthy();
    // Registered but not selected → not mounted. Mounting every imported theme
    // let an unselected pack's unscoped rules apply globally.
    expect(
      document.head.querySelector('style[data-theme-style="ember"]'),
    ).toBeNull();

    await store.set("ui.appearance", "ember");
    syncThemeRegistry(store);
    expect(
      document.head.querySelector('style[data-theme-style="ember"]'),
    ).toBeTruthy();

    applyAppearance("ember");
    expect(document.documentElement.getAttribute("data-theme")).toBe("ember");

    await deleteCustomTheme(store, "ember");

    expect(getRegisteredThemes().some((theme) => theme.id === "ember")).toBe(
      false,
    );
    expect(
      document.head.querySelector('style[data-theme-style="ember"]'),
    ).toBeNull();
  });

  it("locks the color scheme to the selected theme support", async () => {
    const store = await createStore();
    await store.set(THEME_SCHEME_KEY, "light");
    await store.set("ui.appearance", "abyss");

    syncThemeRegistry(store);

    expect(store.get(THEME_SCHEME_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("abyss");
  });
});
