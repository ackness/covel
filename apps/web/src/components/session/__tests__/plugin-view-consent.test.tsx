import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { SettingsStore, type SettingsStoreApi } from "@covel/settings";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  hashPluginViewContent,
  pluginViewContent,
  sessionViewConsentKey,
  usePluginViewConsent,
} from "../plugin-view-consent.js";
import { useGameViewMode } from "../game-view/use-game-view-mode.js";
import { PluginViewHost } from "../plugin-view-host.js";
import { PluginWebview } from "../plugin-webview.js";
import {
  viewEntry,
  pageViewEntry,
  projection,
} from "./plugin-view-fixtures.js";
const mocks = vi.hoisted(() => ({
  store: undefined as SettingsStoreApi | undefined,
  posted: [] as unknown[],
}));
vi.mock("@/settings/use-settings.js", () => ({
  useSettingsStore: () => mocks.store,
}));
vi.mock("../use-session-bridge.js", () => ({
  useSessionBridge: () => ({
    projection,
    stream: { subscribe: () => () => {}, read: () => null },
  }),
}));
vi.mock("../plugin-panel.js", () => ({
  PluginPanel: ({ spec }: { spec: typeof viewEntry.spec }) => (
    <PluginWebview
      title="Consented page"
      html={spec.webview?.html}
      src={spec.webview?.url}
      locked={false}
      handlers={{}}
      state={{ session: projection }}
    />
  ),
}));
vi.mock("../plugin-bridge.js", () => ({
  connectPluginBridge: (
    _: unknown,
    __: unknown,
    host: () => { state: unknown },
  ) => {
    mocks.posted.push(host().state);
    return {
      pushState: (value: unknown) => mocks.posted.push(value),
      pushStream: vi.fn(),
      close: vi.fn(),
    };
  },
}));
vi.mock("@/theme-system/use-theme-snapshot.js", () => ({
  useThemeSnapshot: () => ({ scheme: "light", tokens: {} }),
}));
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  mocks.posted = [];
  const store = new SettingsStore({
    load: async () => ({}),
    save: async () => {},
    loadSecrets: async () => ({}),
    saveSecrets: async () => {},
  });
  await store.init();
  mocks.store = store;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("hashes canonical spec plus HTML and persists per-plugin, per-capability consent", async () => {
  const hash = await hashPluginViewContent(pluginViewContent(viewEntry.spec));
  expect(hash).toHaveLength(64);
  expect(
    await hashPluginViewContent(
      pluginViewContent({ ...viewEntry.spec, webview: { html: "changed" } }),
    ),
  ).not.toBe(hash);
  const { result, rerender } = renderHook(
    ({ entry }) => usePluginViewConsent([entry]),
    { initialProps: { entry: viewEntry } },
  );
  await waitFor(() => expect(result.current.ready(viewEntry)).toBe(true));
  expect(result.current.isAllowed(viewEntry)).toBe(false);
  await act(() => result.current.grant(viewEntry));
  expect(result.current.isAllowed(viewEntry)).toBe(true);
  expect(mocks.store?.get(sessionViewConsentKey("p", hash))).toBe(true);
  const other = {
    ...viewEntry,
    pluginId: "other",
    mode: "plugin:other:v" as const,
  };
  rerender({ entry: other });
  await waitFor(() => expect(result.current.ready(other)).toBe(true));
  expect(result.current.isAllowed(other)).toBe(false);
  const specChange = {
    ...viewEntry,
    spec: { ...viewEntry.spec, description: "Changed spec only" },
  };
  rerender({ entry: specChange });
  await waitFor(() => expect(result.current.ready(specChange)).toBe(true));
  expect(result.current.isAllowed(specChange)).toBe(false);
  const changed = {
    ...viewEntry,
    spec: { ...viewEntry.spec, webview: { html: "changed" } },
  };
  rerender({ entry: changed });
  expect(result.current.isAllowed(changed)).toBe(false);
  await waitFor(() => expect(result.current.ready(changed)).toBe(true));
  expect(result.current.isAllowed(changed)).toBe(false);
  await act(() => result.current.grant(changed));
  expect(result.current.isAllowed(changed)).toBe(true);
  await act(() => result.current.revoke(changed));
  expect(result.current.isAllowed(changed)).toBe(false);
});
it.each([viewEntry, pageViewEntry])(
  "a bridge world default falls back and posts no projection before the player consents ($spec.webview)",
  async (entry) => {
    function Host() {
      const consent = usePluginViewConsent([entry]);
      const [mode, , info] = useGameViewMode(
        { metadata: { defaultViewMode: entry.mode } },
        { views: [entry], status: "ready", reload: () => {} },
        consent.isAllowed,
      );
      return (
        <>
          <span data-testid="mode">{mode}</span>
          <button
            disabled={!consent.ready(entry)}
            onClick={() => void consent.grant(entry)}
          >
            Allow
          </button>
          {mode === entry.mode && (
            <PluginViewHost
              entry={entry}
              sessionId="s"
              sessionBridgeAllowed={consent.isAllowed(entry)}
              onFallback={() => {}}
            />
          )}
          {info.consentView && <p>Consent required</p>}
        </>
      );
    }
    render(<Host />);
    expect(screen.getByTestId("mode").textContent).toBe("parsed");
    await waitFor(() =>
      expect((screen.getByText("Allow") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByTitle("Consented page")).toBeNull();
    expect(mocks.posted).toEqual([]);
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() =>
      expect(screen.getByTestId("mode").textContent).toBe(entry.mode),
    );
    fireEvent.load(screen.getByTitle("Consented page"));
    expect(mocks.posted).toEqual([
      expect.objectContaining({ session: projection }),
    ]);
  },
);
it("binds page consent to every published file through the URL digest", async () => {
  const entry = {
    ...viewEntry,
    spec: {
      ...viewEntry.spec,
      webview: { url: `/plugin-assets/p/${"a".repeat(32)}/index.html` },
    },
  };
  const changed = {
    ...entry,
    spec: {
      ...entry.spec,
      webview: { url: `/plugin-assets/p/${"b".repeat(32)}/index.html` },
    },
  };
  const hash = await hashPluginViewContent(pluginViewContent(entry.spec));
  expect(await hashPluginViewContent(pluginViewContent(changed.spec))).not.toBe(
    hash,
  );
  const { result, rerender } = renderHook(
    ({ entry }) => usePluginViewConsent([entry]),
    { initialProps: { entry } },
  );
  await waitFor(() => expect(result.current.ready(entry)).toBe(true));
  await act(() => result.current.grant(entry));
  expect(result.current.isAllowed(entry)).toBe(true);
  rerender({ entry: changed });
  expect(result.current.isAllowed(changed)).toBe(false);
  await waitFor(() => expect(result.current.ready(changed)).toBe(true));
  expect(result.current.isAllowed(changed)).toBe(false);
});
