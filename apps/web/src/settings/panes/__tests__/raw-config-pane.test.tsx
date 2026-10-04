import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SettingsStore } from "@covel/settings";
import i18n from "@/i18n";
import { RawConfigPane } from "../RawConfigPane.js";

const mocks = vi.hoisted(() => ({
  store: null as unknown as SettingsStore,
  files: [] as unknown[],
  read: vi.fn(),
  save: vi.fn(),
  boot: vi.fn(),
}));
vi.mock("../../use-settings.js", () => ({
  useSettingsStore: () => mocks.store,
}));
vi.mock("../../store.js", () => ({
  settingLabels: (keys: readonly string[]) => keys.join(", "),
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ boot: mocks.boot }),
}));
vi.mock("@/services/api/raw-config.js", () => ({
  listRawConfigFiles: async () => mocks.files,
  readRawConfigFile: mocks.read,
  saveRawConfigFile: mocks.save,
}));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  mocks.files = [];
  mocks.read.mockReset();
  mocks.save.mockReset();
  mocks.boot.mockReset().mockResolvedValue(undefined);
  let entries: Record<string, unknown> = { "ui.scheme": "dark", extra: 1 };
  mocks.store = new SettingsStore({
    load: async () => ({ ...entries }),
    save: async (next) => {
      entries = { ...next };
    },
    loadSecrets: async () => ({}),
    saveSecrets: async () => undefined,
  });
  mocks.store.register({
    key: "ui.scheme",
    schema: z.enum(["light", "dark"]),
    default: "dark",
    group: "general",
    label: "Color scheme",
  });
  await mocks.store.init();
});
afterEach(cleanup);

async function editor(name: string) {
  const area = (await screen.findByRole("textbox", {
    name,
  })) as HTMLTextAreaElement;
  await waitFor(() => expect(area.disabled).toBe(false));
  return area;
}
const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

it("shows the stored settings and writes only what the edit changes", async () => {
  render(<RawConfigPane />);
  const area = await editor("Settings (JSON)");
  expect(JSON.parse(area.value)).toEqual({ "ui.scheme": "dark", extra: 1 });

  // One value changed, one key deleted, one key added.
  fireEvent.change(area, {
    target: { value: JSON.stringify({ "ui.scheme": "light", added: true }) },
  });
  save();
  await screen.findByText("Saved.");
  expect(mocks.store.get("ui.scheme")).toBe("light");
  expect(mocks.store.get("added")).toBe(true);
  expect(mocks.store.has("extra")).toBe(false);
});

it("refuses a value the setting does not accept, API keys, and broken JSON", async () => {
  render(<RawConfigPane />);
  const area = await editor("Settings (JSON)");
  for (const [text, message] of [
    [JSON.stringify({ "ui.scheme": "sepia" }), /refuse their value: ui.scheme/],
    [JSON.stringify({ "keys.openai": "sk-x" }), /API keys are not saved here/],
    ['{ "ui.scheme": ', /Not valid JSON/],
    ["[]", /must be a JSON object/],
  ] as const) {
    fireEvent.change(area, { target: { value: text } });
    save();
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(mocks.store.get("ui.scheme")).toBe("dark");
    expect(mocks.store.get("extra")).toBe(1);
  }
});

it("saves a file against the digest it was read with and reloads the model roles", async () => {
  mocks.files = [
    {
      name: "llm.toml",
      path: "/etc/llm.toml",
      exists: true,
      applies: "reload",
    },
  ];
  mocks.read.mockResolvedValue({
    name: "llm.toml",
    path: "/etc/llm.toml",
    exists: true,
    applies: "reload",
    content: "[covel.story]\n",
    digest: "digest-1",
  });
  mocks.save.mockResolvedValue({
    content: "[covel.plot]\n",
    digest: "digest-2",
    backup: "/etc/llm.toml.bak",
    reload: { ok: true, slots: ["plot"] },
  });
  render(<RawConfigPane />);
  fireEvent.click(await screen.findByRole("tab", { name: "llm.toml" }));
  const area = await editor("llm.toml");
  await waitFor(() => expect(area.value).toBe("[covel.story]\n"));

  fireEvent.change(area, { target: { value: "[covel.plot]\n" } });
  save();
  await screen.findByText(
    "Saved. The text before the change is kept as /etc/llm.toml.bak.",
  );
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(
    "llm.toml",
    "[covel.plot]\n",
    "digest-1",
  );
  expect(mocks.boot).toHaveBeenCalledTimes(1);
});
