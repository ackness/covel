import type { SettingsPersistenceBundle } from "@covel/shared/settings-persistence";
import { afterEach, expect, it, vi } from "vitest";
import {
  SettingsStore,
  SettingsRevisionConflictError,
  type SettingsBackendAdapter,
} from "@covel/settings";
import {
  THEME_LAYOUT_PRESET_IDS,
  type ResolvedPluginTheme,
} from "@covel/shared";
import {
  PluginThemeSession,
  sessionThemeKey,
  effectivePluginPalette,
  resolveSessionThemeLayout,
} from "../plugin-themes.js";
import {
  primeThemeRegistry,
  syncThemeRegistry,
  getRegisteredThemes,
} from "../registry.js";
import { resolveThemeLayout } from "../layout.js";
import { APPEARANCE_TOKENS_KEY } from "../overrides.js";

import {
  themeFixture,
  choiceOf,
  themeStore,
  openTheme,
} from "./plugin-theme-fixture.js";
const sources: PluginThemeSession[] = [];
afterEach(() => {
  for (const source of sources.splice(0)) source.dispose();
  document.head.querySelectorAll("style").forEach((node) => node.remove());
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const track = (source: PluginThemeSession) => {
  sources.push(source);
  return source;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("starts off, persists only the exact identity, and mounts one session source apart from the global library", async () => {
  const { store, adapter } = await themeStore();
  const before = await store.export();
  const source = track(await openTheme(store));
  expect(source.state.effective).toBeNull();
  expect(
    document.querySelectorAll("style[data-plugin-theme-style]"),
  ).toHaveLength(0);
  expect(await source.select(choiceOf(themeFixture()))).toBe(true);
  expect(source.state.effective?.source).toBe("plugin");
  expect(
    document.querySelectorAll("style[data-plugin-theme-style]"),
  ).toHaveLength(1);
  const css = document.querySelector(
    "style[data-plugin-theme-style]",
  )!.textContent;
  expect(css).toContain(source.scope);
  expect(css).toContain("/plugin-assets/reading-pack/");
  expect(css).not.toContain(
    `[data-covel-theme-scope="${themeFixture().contentHash}"]`,
  );
  syncThemeRegistry(store);
  syncThemeRegistry(store);
  expect(
    document.querySelectorAll("style[data-plugin-theme-style]"),
  ).toHaveLength(1);
  expect(getRegisteredThemes().some((theme) => theme.source === "plugin")).toBe(
    false,
  );
  expect((await store.export()).entries).toEqual({
    ...before.entries,
    [sessionThemeKey(source.sessionId)]: choiceOf(themeFixture()),
  });
  source.dispose();
  const reloaded = new SettingsStore(adapter);
  primeThemeRegistry(reloaded);
  await reloaded.init();
  const restored = track(await openTheme(reloaded));
  expect(restored.state.effective?.themeId).toBe("reading");
  const fresh = track(await openTheme(reloaded, "forked-session"));
  restored.dispose();
  expect(fresh.state.effective).toBeNull();
});

it("composes palettes for both schemes and lets player typography win, then reveals the latest base", async () => {
  const { store } = await themeStore({
    "ui.appearance": "panel",
    "ui.scheme": "light",
  });
  const source = track(await openTheme(store));
  await source.select(choiceOf(themeFixture()));
  expect(effectivePluginPalette(store, themeFixture())["--story-color"]).toBe(
    "#302818",
  );
  await store.set("ui.scheme", "dark");
  syncThemeRegistry(store);
  expect(effectivePluginPalette(store, themeFixture())["--story-color"]).toBe(
    "#f5ead2",
  );
  await store.set(APPEARANCE_TOKENS_KEY, {
    shared: {
      "--story-font-size": "1.5rem",
      "--story-line-height": "2.2",
      "--story-font-family": "serif",
    },
    light: { "--story-color": "#223344" },
    dark: { "--story-color": "#abcdef" },
  });
  expect(effectivePluginPalette(store, themeFixture())["--story-color"]).toBe(
    "#abcdef",
  );
  const css = document.querySelector(
    "style[data-plugin-theme-style]",
  )!.textContent;
  expect(css).toContain("font-size: 1.5rem !important");
  expect(css).toContain("line-height: 2.2 !important");
  expect(document.documentElement.style.getPropertyValue("--story-color")).toBe(
    "",
  );
  await store.set("ui.appearance", "book");
  syncThemeRegistry(store);
  await source.select(null);
  expect(document.documentElement.dataset.backdrop).toBe("banner");
  expect(document.querySelector("style[data-plugin-theme-style]")).toBeNull();
  expect(store.get(APPEARANCE_TOKENS_KEY)).toMatchObject({
    dark: { "--story-color": "#abcdef" },
  });
});

it.each(THEME_LAYOUT_PRESET_IDS)(
  "overlays only session options from %s, leaving the player's navigation and world list",
  async (preset) => {
    const { store } = await themeStore({ "ui.appearance": "panel" });
    const theme = { ...themeFixture(), layout: { preset } };
    const source = track(await openTheme(store, "session-one", theme));
    await source.select(choiceOf(theme));
    const base = resolveThemeLayout({ preset: "panel" });
    const expected = resolveThemeLayout({ preset });
    expect(resolveSessionThemeLayout(store, base)).toEqual({
      ...base,
      panelTabs: expected.panelTabs,
      backdrop: expected.backdrop,
      turnNotes: expected.turnNotes,
    });
    source.replace(
      [{ theme: { ...theme, layout: undefined }, owner: "Author" }],
      "ready",
    );
    expect(resolveSessionThemeLayout(store, base)).toEqual(base);
  },
);

it("rejects corrupted DTOs atomically and leaves changed or unavailable identities inactive", async () => {
  const { store } = await themeStore();
  const source = track(await openTheme(store));
  await source.select(choiceOf(themeFixture()));
  for (const change of [
    { cssText: "html{color:red}" },
    { assets: { ...themeFixture().assets!, digest: "c".repeat(32) } },
    { contentHash: "d".repeat(64) },
    { pluginId: "another-owner" },
    { tokens: { dark: { "--story-color": "url(/api/keys)" } } },
  ]) {
    source.replace(
      [
        {
          theme: { ...themeFixture(), ...change } as ResolvedPluginTheme,
          owner: "Author",
        },
      ],
      "ready",
    );
    expect(source.state.effective).toBeNull();
    expect(document.querySelector("style[data-plugin-theme-style]")).toBeNull();
  }
  source.replace([], "error");
  expect(source.state.selected).toEqual(choiceOf(themeFixture()));
  source.replace([{ theme: themeFixture(), owner: "Author" }], "ready");
  await vi.waitFor(() => expect(source.state.effective).not.toBeNull());
  source.replace([], "loading");
  expect(source.state.effective).toBeNull();
});

it("keeps a failed default action blocked across refreshes and global updates, then permits a deliberate retry", async () => {
  const { store, save } = await themeStore();
  const source = track(await openTheme(store));
  await source.select(choiceOf(themeFixture()));
  save.mockRejectedValueOnce(new Error("disk unavailable"));
  const off = source.select(null);
  expect(document.querySelector("style[data-plugin-theme-style]")).toBeNull();
  expect(await off).toBe(false);
  expect(source.state.error).toBe("off-save");
  expect(source.state.selected).toEqual(choiceOf(themeFixture()));
  source.replace([{ theme: themeFixture(), owner: "Author" }], "ready");
  await store.set("ui.scheme", "light");
  syncThemeRegistry(store);
  expect(source.state.effective).toBeNull();
  expect(await source.select(choiceOf(themeFixture()))).toBe(true);
  await vi.waitFor(() => expect(source.state.effective).not.toBeNull());
});

it("waits for confirmed writes and ignores late selection after Off or another session's ownership", async () => {
  const { store, save } = await themeStore();
  const source = track(await openTheme(store));
  let finish!: () => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = source.select(choiceOf(themeFixture()));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(source.state.effective).toBeNull();
  const off = source.select(null);
  finish();
  await pending;
  await off;
  expect(source.state.effective).toBeNull();
  await source.select(choiceOf(themeFixture()));
  const next = track(await openTheme(store, "session-two"));
  await next.select(choiceOf(themeFixture()));
  source.dispose();
  expect(
    document.querySelectorAll("style[data-plugin-theme-style]"),
  ).toHaveLength(1);
  expect(
    document.querySelector("style[data-plugin-theme-style]")!.textContent,
  ).toContain(next.scope);
});

it.each([
  { off: false, fail: false },
  { off: false, fail: true },
  { off: true, fail: false },
  { off: true, fail: true },
])(
  "settles a delayed choice across discovery refresh (off=$off, fail=$fail)",
  async ({ off, fail }) => {
    const { store, save, adapter } = await themeStore();
    const source = track(await openTheme(store));
    const choice = choiceOf(themeFixture());
    if (off) expect(await source.select(choice)).toBe(true);
    const gate = deferred<void>();
    const persist = save.getMockImplementation()!;
    save.mockImplementationOnce(async (entries) => {
      await gate.promise;
      await persist(entries);
    });
    const write = source.select(off ? null : choice);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(off ? 2 : 1));

    source.replace([], "loading");
    expect(source.state.saving).toBe(true);
    expect(source.state.effective).toBeNull();
    source.replace([{ theme: themeFixture(), owner: "Author" }], "ready");
    expect(source.state.saving).toBe(true);
    expect(source.state.effective).toBeNull();

    if (fail) gate.reject(new Error("disk unavailable"));
    else gate.resolve();
    expect(await write).toBe(!fail);
    expect(source.state.saving).toBe(false);
    expect(source.state.error).toBe(fail ? (off ? "off-save" : "save") : null);
    const confirmed = off === fail ? choice : null;
    expect(source.state.selected).toEqual(confirmed);
    expect(store.get(sessionThemeKey(source.sessionId))).toEqual(confirmed);
    await vi.waitFor(() =>
      expect(source.state.effective?.themeId ?? null).toBe(
        !off && !fail ? "reading" : null,
      ),
    );
    source.replace([{ theme: themeFixture(), owner: "Author" }], "ready");
    await store.set("ui.scheme", "light");
    expect(source.state.error).toBe(fail ? (off ? "off-save" : "save") : null);
    if (off) expect(source.state.effective).toBeNull();
    const reloaded = new SettingsStore(adapter);
    primeThemeRegistry(reloaded);
    await reloaded.init();
    const restored = track(await openTheme(reloaded));
    expect(restored.state.selected).toEqual(confirmed);
    await vi.waitFor(() =>
      expect(restored.state.effective?.themeId ?? null).toBe(
        confirmed ? "reading" : null,
      ),
    );
  },
);

it("does not persist a choice whose resource check was retired by discovery", async () => {
  const { store, save } = await themeStore();
  const source = track(await openTheme(store));
  const gate = deferred<Response>();
  vi.mocked(fetch).mockImplementationOnce(() => gate.promise);
  const write = source.select(choiceOf(themeFixture()));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  source.replace([], "loading");
  gate.resolve(new Response(null, { status: 404 }));
  expect(await write).toBe(false);
  expect(save).not.toHaveBeenCalled();
  expect(source.state.saving).toBe(false);
  expect(source.state.error).toBeNull();
});

it("confirms a saved choice during discovery without reviving an unavailable pack", async () => {
  const { store, save } = await themeStore();
  const source = track(await openTheme(store));
  const gate = deferred<void>();
  save.mockImplementationOnce(() => gate.promise);
  const write = source.select(choiceOf(themeFixture()));
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  source.replace([], "loading");
  gate.resolve();
  expect(await write).toBe(true);
  expect(source.state.saving).toBe(false);
  expect(source.state.selected).toEqual(choiceOf(themeFixture()));
  expect(source.state.effective).toBeNull();
  source.replace([], "ready");
  expect(source.state.effective).toBeNull();
  source.replace([{ theme: themeFixture(), owner: "Author" }], "ready");
  await vi.waitFor(() =>
    expect(source.state.effective?.themeId).toBe("reading"),
  );
});

it("restores the last confirmed source on failed selection and validates imported choices", async () => {
  const { store, save } = await themeStore();
  const source = track(await openTheme(store));
  const other = themeFixture("other", "c".repeat(64));
  source.replace(
    [
      { theme: themeFixture(), owner: "Author" },
      { theme: other, owner: "Other" },
    ],
    "ready",
  );
  await source.select(choiceOf(themeFixture()));
  save.mockRejectedValueOnce(new Error("cannot save"));
  expect(await source.select(choiceOf(other))).toBe(false);
  expect(source.state.effective?.themeId).toBe("reading");
  expect(source.state.error).toBe("save");
  await expect(
    store.set(sessionThemeKey(source.sessionId), {
      ...choiceOf(other),
      cssText: "bad",
    }),
  ).rejects.toThrow();
  await expect(
    store.set(sessionThemeKey(source.sessionId), {
      ...choiceOf(other),
      contentHash: "bad",
    }),
  ).rejects.toThrow();
  expect(source.state.effective?.themeId).toBe("reading");
});

it("fails atomically on a missing bitmap and ignores an old resource probe after reset", async () => {
  const { store } = await themeStore();
  const source = track(await openTheme(store));
  const fetcher = vi.mocked(fetch);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await source.select(choiceOf(themeFixture()))).toBe(false);
  expect(source.state.effective).toBeNull();
  expect(source.state.error).toBe("resource");
  source.replace([{ theme: themeFixture(), owner: "Author" }], "ready");
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = source.select(choiceOf(themeFixture()));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await source.select(null);
  finish(
    new Response(null, {
      headers: { "content-type": "image/png", "content-length": "24" },
    }),
  );
  await pending;
  expect(source.state.effective).toBeNull();
  expect(store.has(sessionThemeKey(source.sessionId))).toBe(false);
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringMatching(
      /^\/plugin-assets\/reading-pack\/[a-f0-9]{32}\/paper.png$/,
    ),
    expect.objectContaining({
      method: "HEAD",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }),
  );
});
it("supports token-only and layout-only themes without fabricated CSS, assets or resource requests", async () => {
  const { store } = await themeStore();
  const source = track(await openTheme(store));
  for (const theme of [
    {
      pluginId: "reading-pack",
      id: "palette",
      label: "Palette",
      contentHash: "d".repeat(64),
      tokens: { dark: { "--story-color": "#abcdef" } },
    },
    {
      pluginId: "reading-pack",
      id: "layout",
      label: "Layout",
      contentHash: "e".repeat(64),
      layout: { preset: "book" as const },
    },
  ]) {
    source.replace([{ theme, owner: "Author" }], "ready");
    expect(await source.select(choiceOf(theme))).toBe(true);
    expect(source.state.effective?.themeId).toBe(theme.id);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps an unconfirmed identity inactive when the same session remounts during persistence", async () => {
  const { store, save } = await themeStore();
  const first = track(await openTheme(store));
  let finish!: () => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const write = first.select(choiceOf(themeFixture()));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const next = track(await openTheme(store));
  expect(next.state.effective).toBeNull();
  finish();
  await write;
  await vi.waitFor(() => expect(next.state.effective?.themeId).toBe("reading"));
});
it("preserves a newer choice when older completions arrive in reverse order", async () => {
  const { store } = await themeStore();
  const source = track(await openTheme(store));
  const second = themeFixture("second", "c".repeat(64));
  source.replace(
    [
      { theme: themeFixture(), owner: "Author" },
      { theme: second, owner: "Author" },
    ],
    "ready",
  );
  const original = store.set.bind(store);
  let release!: () => void;
  vi.spyOn(store, "set").mockImplementationOnce(async (key, value) => {
    await original(key, value);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const older = source.select(choiceOf(themeFixture()));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(await source.select(choiceOf(second))).toBe(true);
  release();
  await older;
  expect(source.state.effective?.themeId).toBe("second");
  expect(
    document.querySelectorAll("style[data-plugin-theme-style]"),
  ).toHaveLength(1);
});
it("honors revision conflicts and does not overwrite another window's session choice or unrelated settings", async () => {
  let bundle: SettingsPersistenceBundle = {
    schemaVersion: 2,
    revision: 0,
    savedAt: "",
    entries: {},
  };
  const adapter: SettingsBackendAdapter = {
    load: async () => bundle.entries,
    save: async () => {},
    loadSecrets: async () => ({}),
    saveSecrets: async () => {},
    loadWithRevision: async () => structuredClone(bundle),
    saveWithRevision: async (entries, expected) => {
      if (expected !== bundle.revision)
        throw new SettingsRevisionConflictError(bundle.revision);
      bundle = {
        ...bundle,
        revision: expected + 1,
        entries: structuredClone(entries),
      };
      return structuredClone(bundle);
    },
  };
  const local = new SettingsStore(adapter),
    remote = new SettingsStore(adapter);
  primeThemeRegistry(local);
  primeThemeRegistry(remote);
  await local.init();
  await remote.init();
  const source = track(
    await openTheme(local, "session-one", {
      ...themeFixture(),
      assets: undefined,
      cssText: undefined,
    }),
  );
  const changed = choiceOf(themeFixture("changed", "c".repeat(64)));
  await remote.set(sessionThemeKey("session-one"), changed);
  await remote.set("unrelated", "remote value");
  expect(await source.select(choiceOf(themeFixture()))).toBe(false);
  expect(source.state.effective).toBeNull();
  expect(source.state.selected).toEqual(changed);
  expect(source.state.error).toBe("save");
  expect(bundle.entries).toMatchObject({
    [sessionThemeKey("session-one")]: changed,
    unrelated: "remote value",
  });
  expect(await source.select(choiceOf(themeFixture()))).toBe(true);
  expect(bundle.entries.unrelated).toBe("remote value");
});
