import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@covel/settings";
import { registerCoreSettings } from "../registry/core.js";
import { SettingWidget } from "../widgets/index.js";
import i18n from "@/i18n/index.js";
import { Reveal } from "@/lib/reveal/Reveal.js";
const settings = vi.hoisted(() => ({ store: null as SettingsStore | null }));
vi.mock("../store.js", () => ({ getSettings: () => settings.store }));
vi.mock("../use-settings-save.js", () => ({ useSettingsWritable: () => true }));
vi.mock("@/hooks/use-media-query.js", () => ({ useMediaQuery: () => false }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("persists the Instant text override through the real generic widget and finishes an active reveal", async () => {
  let saved: Record<string, unknown> = {};
  const store = new SettingsStore({
    load: async () => saved,
    loadSecrets: async () => ({}),
    saveSecrets: async () => {},
    save: async (entries) => {
      saved = entries;
    },
  });
  settings.store = store;
  registerCoreSettings(store);
  await store.init();
  await i18n.changeLanguage("en-US");
  const entry = store
    .listEntries()
    .find((item) => item.key === "ui.instantText")!;
  expect(store.get("ui.instantText")).toBe(false);
  expect(entry.schema.safeParse("true").success).toBe(false);
  const content = (key: string) => (
    <>
      <SettingWidget entry={entry} />
      <Reveal revealKey={key} mode="segments">
        <p>First whole paragraph</p>
        <p>Second whole paragraph</p>
      </Reveal>
    </>
  );
  vi.useFakeTimers();
  const view = render(content("history"));
  view.rerender(content("new"));
  expect(document.querySelector('[data-reveal-hidden="true"]')).not.toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("switch", { name: "Instant text" })),
  );
  expect(saved["ui.instantText"]).toBe(true);
  expect(document.querySelector('[data-reveal-hidden="true"]')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
