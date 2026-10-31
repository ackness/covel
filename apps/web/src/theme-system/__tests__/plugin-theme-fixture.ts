import { vi } from "vitest";
import { SettingsStore, type SettingsBackendAdapter } from "@covel/settings";
import { compilePluginThemeCss, type ResolvedPluginTheme } from "@covel/shared";
import { PluginThemeSession } from "../plugin-themes.js";
import { primeThemeRegistry, syncThemeRegistry } from "../registry.js";
export function themeFixture(
  id = "reading",
  hash = "a".repeat(64),
): ResolvedPluginTheme {
  const assets = {
    digest: "b".repeat(32),
    files: [{ path: "paper.png", mime: "image/png" as const, size: 24 }],
  };
  const compiled = compilePluginThemeCss(
    ".story,.dialogue{color:var(--story-color);font-size:1rem;line-height:1.8}.surface{background-image:url(paper.png)}",
    { pluginId: "reading-pack", scope: hash, assets },
  );
  if (!compiled.success) throw new Error("invalid test theme");
  return {
    pluginId: "reading-pack",
    id,
    label: "Reading room",
    contentHash: hash,
    cssText: compiled.css,
    assets,
    tokens: {
      light: { "--story-color": "#302818" },
      dark: { "--story-color": "#f5ead2" },
    },
    layout: { preset: "book" },
  };
}
export const choiceOf = (theme: ResolvedPluginTheme) => ({
  pluginId: theme.pluginId,
  themeId: theme.id,
  contentHash: theme.contentHash,
});
export async function themeStore(seed: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(null, {
          headers: { "content-type": "image/png", "content-length": "24" },
        }),
    ),
  );
  let saved = structuredClone(seed);
  const save = vi.fn<SettingsBackendAdapter["save"]>(async (next) => {
    saved = structuredClone(next);
  });
  const adapter: SettingsBackendAdapter = {
    load: async () => saved,
    save,
    loadSecrets: async () => ({}),
    saveSecrets: async () => {},
  };
  const store = new SettingsStore(adapter);
  primeThemeRegistry(store);
  await store.init();
  syncThemeRegistry(store);
  return { store, save, adapter };
}
export async function openTheme(
  store: SettingsStore,
  session = "session-one",
  theme = themeFixture(),
) {
  const source = new PluginThemeSession(store, session);
  await store.ready();
  await Promise.resolve();
  source.replace([{ theme, owner: "Reading author" }], "ready");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return source;
}
