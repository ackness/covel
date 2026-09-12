import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SettingsStore } from "@covel/settings";
import i18n from "@/i18n";
import { DataPane } from "../DataPane.js";

const mocks = vi.hoisted(() => ({
  store: null as unknown as SettingsStore,
  save: vi.fn(),
}));
vi.mock("../use-settings.js", () => ({ useSettingsStore: () => mocks.store }));
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.store = new SettingsStore({
    load: async () => ({}),
    save: mocks.save,
    loadSecrets: async () => ({}),
    saveSecrets: async () => undefined,
  });
  mocks.store.register({
    key: "fixture.count",
    default: 1,
    schema: z.number().int().min(1),
    group: "general",
    label: "Count",
  });
  await mocks.store.init();
});
function importBundle(bundle: unknown) {
  const file = { text: async () => JSON.stringify(bundle) };
  fireEvent.change(screen.getByLabelText("Choose file..."), {
    target: { files: [file] },
  });
}
it("previews old-schema entries without silently reporting them as imported", async () => {
  render(<DataPane />);
  importBundle({
    schemaVersion: 1,
    entries: { "fixture.count": "old format", "fixture.extra": true },
  });
  const invalid = await screen.findByRole("checkbox", {
    name: "fixture.count",
  });
  expect((invalid as HTMLInputElement).disabled).toBe(true);
  expect((invalid as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole("status").textContent).toContain("1 entries");
  fireEvent.click(screen.getByRole("button", { name: /Apply.*1/ }));
  await waitFor(() => expect(mocks.store.get("fixture.extra")).toBe(true));
  expect(mocks.store.get("fixture.count")).toBe(1);
});
it("keeps the import preview and reports a persistence failure", async () => {
  render(<DataPane />);
  mocks.save.mockRejectedValueOnce(new Error("synthetic storage failure"));
  importBundle({ schemaVersion: 1, entries: { "fixture.count": 2 } });
  fireEvent.click(await screen.findByRole("button", { name: /Apply.*1/ }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "fixture.count" })).toBeTruthy();
  expect(mocks.store.get("fixture.count")).toBe(1);
});
it("rejects an array instead of treating it as a settings map", async () => {
  render(<DataPane />);
  importBundle({ schemaVersion: 1, entries: [] });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();
});
