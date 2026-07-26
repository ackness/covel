import { beforeEach, describe, expect, it } from "vitest";
import { SettingsStore, type SettingsBackendAdapter } from "@covel/settings";
import { THEME_SCHEME_KEY } from "@/lib/appearance.js";
import { primeThemeRegistry } from "../registry.js";
import {
  APPEARANCE_TOKENS_KEY,
  applyTokenOverrides,
  clearOverrides,
  clearTokenOverride,
  countOverrides,
  getTokenOverride,
  loadOverrides,
  replaceOverrides,
  resolveActiveOverrides,
  setTokenOverride,
} from "../overrides.js";
import { formatLength, parseLength } from "../token-schema.js";

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

async function createStore(scheme: "light" | "dark" = "dark") {
  const store = new SettingsStore(new MemorySettingsAdapter());
  await store.init();
  primeThemeRegistry(store);
  await store.set(THEME_SCHEME_KEY, scheme);
  return store;
}

describe("appearance token overrides", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("routes colour tokens into the active scheme bucket", async () => {
    const store = await createStore("dark");

    await setTokenOverride(store, "--surface-page", "#101014");

    const overrides = loadOverrides(store);
    expect(overrides.dark["--surface-page"]).toBe("#101014");
    expect(overrides.light["--surface-page"]).toBeUndefined();
    expect(overrides.shared["--surface-page"]).toBeUndefined();
  });

  it("routes size and font tokens into the shared bucket", async () => {
    const store = await createStore("dark");

    await setTokenOverride(store, "--story-font-size", "1.125rem");

    const overrides = loadOverrides(store);
    expect(overrides.shared["--story-font-size"]).toBe("1.125rem");
    expect(overrides.dark["--story-font-size"]).toBeUndefined();
  });

  it("keeps light and dark colours independent", async () => {
    const store = await createStore("dark");
    await setTokenOverride(store, "--color-primary", "#ff8844");
    await store.set(THEME_SCHEME_KEY, "light");
    await setTokenOverride(store, "--color-primary", "#3311aa");

    const overrides = loadOverrides(store);
    expect(overrides.dark["--color-primary"]).toBe("#ff8844");
    expect(overrides.light["--color-primary"]).toBe("#3311aa");
    expect(getTokenOverride(overrides, "--color-primary", "light")).toBe(
      "#3311aa",
    );
  });

  it("shared tokens resolve in both schemes, colours only in their own", async () => {
    const store = await createStore("dark");
    await setTokenOverride(store, "--story-font-size", "1.25rem");
    await setTokenOverride(store, "--surface-page", "#000000");

    const overrides = loadOverrides(store);
    expect(resolveActiveOverrides(overrides, "dark")).toEqual({
      "--story-font-size": "1.25rem",
      "--surface-page": "#000000",
    });
    expect(resolveActiveOverrides(overrides, "light")).toEqual({
      "--story-font-size": "1.25rem",
    });
  });

  it("writes active overrides to the document and removes stale ones", async () => {
    const store = await createStore("dark");
    await setTokenOverride(store, "--story-font-size", "1.5rem");
    applyTokenOverrides(store);

    expect(
      document.documentElement.style.getPropertyValue("--story-font-size"),
    ).toBe("1.5rem");

    await clearTokenOverride(store, "--story-font-size");
    applyTokenOverrides(store);

    expect(
      document.documentElement.style.getPropertyValue("--story-font-size"),
    ).toBe("");
  });

  it("drops colour overrides from the document when the scheme flips", async () => {
    const store = await createStore("dark");
    await setTokenOverride(store, "--surface-page", "#101014");
    applyTokenOverrides(store);
    expect(
      document.documentElement.style.getPropertyValue("--surface-page"),
    ).toBe("#101014");

    await store.set(THEME_SCHEME_KEY, "light");
    applyTokenOverrides(store);

    expect(
      document.documentElement.style.getPropertyValue("--surface-page"),
    ).toBe("");
  });

  it("rejects unknown tokens, non-strings and oversized values on read", async () => {
    const store = await createStore("dark");
    // Simulates a hand-edited or imported settings blob: unregistered keys
    // bypass the store's schema validation entirely.
    await store.set(APPEARANCE_TOKENS_KEY, {
      shared: {
        "--story-font-size": "1rem",
        "--not-a-real-token": "12px",
        "--story-max-width": 42,
        "--story-line-height": "x".repeat(3000),
      },
      light: {},
      dark: {},
    });

    expect(loadOverrides(store).shared).toEqual({
      "--story-font-size": "1rem",
    });
  });

  it("clears one group without touching the others", async () => {
    const store = await createStore("dark");
    await setTokenOverride(store, "--story-font-size", "1.25rem");
    await setTokenOverride(store, "--rail-width-left", "20rem");

    await clearOverrides(store, ["--story-font-size"]);

    const overrides = loadOverrides(store);
    expect(overrides.shared["--story-font-size"]).toBeUndefined();
    expect(overrides.shared["--rail-width-left"]).toBe("20rem");
  });

  it("clears everything and counts across all buckets", async () => {
    const store = await createStore("dark");
    await setTokenOverride(store, "--story-font-size", "1.25rem");
    await setTokenOverride(store, "--surface-page", "#000000");
    expect(countOverrides(loadOverrides(store))).toBe(2);

    await clearOverrides(store);
    expect(countOverrides(loadOverrides(store))).toBe(0);
  });

  it("filters an imported bundle through the same normalisation", async () => {
    const store = await createStore("dark");

    await replaceOverrides(store, {
      shared: { "--story-font-size": "1.125rem", "--evil": "boom" },
      light: { "--color-primary": "#123456" },
      dark: {},
    } as never);

    const overrides = loadOverrides(store);
    expect(overrides.shared).toEqual({ "--story-font-size": "1.125rem" });
    expect(overrides.light).toEqual({ "--color-primary": "#123456" });
  });
});

describe("length values", () => {
  it("parses a matching unit and rejects a mismatched one", () => {
    expect(parseLength("1.25rem", "rem")).toBe(1.25);
    expect(parseLength("-0.02em", "em")).toBe(-0.02);
    expect(parseLength("12px", "rem")).toBeNull();
    expect(parseLength("clamp(15rem, 17vw, 18rem)", "rem")).toBeNull();
  });

  it("treats a bare zero as a valid length in any unit", () => {
    expect(parseLength("0", "rem")).toBe(0);
    expect(formatLength(0, "rem")).toBe("0");
  });

  it("formats without float noise", () => {
    expect(formatLength(0.1 + 0.2, "rem")).toBe("0.3rem");
    expect(formatLength(1.0625, "rem")).toBe("1.0625rem");
  });
});
