import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsStoreApi } from "@covel/settings";
import {
  subscribePluginThemes,
  type PluginThemeSession,
} from "../plugin-themes.js";
import { usePluginThemePart } from "../use-plugin-theme.js";
import {
  choiceOf,
  openTheme,
  themeFixture,
  themeStore,
} from "./plugin-theme-fixture.js";

const current = vi.hoisted(() => ({
  store: undefined as unknown as SettingsStoreApi,
}));
vi.mock("@/settings/store.js", () => ({ getSettings: () => current.store }));

let source: PluginThemeSession | undefined;
afterEach(() => {
  cleanup();
  source?.dispose();
});

function Probe({ onRender }: { onRender: (scope: unknown) => void }) {
  const part = usePluginThemePart("session-one", "story");
  onRender(part["data-covel-theme-scope"]);
  return null;
}

it("re-renders only when the session's effective theme changes", async () => {
  const { store } = await themeStore();
  current.store = store;
  const pack = themeFixture();
  source = await openTheme(store, "session-one", pack);
  await source.select(choiceOf(pack));
  const renders: unknown[] = [];
  render(<Probe onRender={(scope) => renders.push(scope)} />);
  expect(renders).toEqual([source.scope]);

  // Selecting the same theme again publishes, but nothing a body reads
  // moved: Markdown bodies must not re-render and re-parse.
  const published = vi.fn();
  const stop = subscribePluginThemes(store, published);
  await act(async () => source!.select(choiceOf(pack)));
  stop();
  expect(published).toHaveBeenCalled();
  expect(renders).toEqual([source.scope]);

  await act(async () => source!.select(null));
  expect(renders).toEqual([source.scope, undefined]);
});
