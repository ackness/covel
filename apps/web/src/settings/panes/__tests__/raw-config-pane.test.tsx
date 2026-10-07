import {
  act,
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
import { ApiError } from "@/services/api/request.js";

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

it("keeps a late file read from replacing the newly selected file", async () => {
  mocks.files = ["llm.toml", "config.toml"].map((name) => ({
    name,
    path: `/etc/${name}`,
    exists: true,
    applies: "restart",
  }));
  let finishOld!: (value: unknown) => void;
  mocks.read.mockImplementation((name: string) =>
    name === "llm.toml"
      ? new Promise((resolve) => {
          finishOld = resolve;
        })
      : Promise.resolve({
          content: "[desktop]",
          digest: "config-digest",
          exists: true,
        }),
  );
  render(<RawConfigPane />);
  await editor("Settings (JSON)");
  fireEvent.click(await screen.findByRole("tab", { name: "llm.toml" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith("llm.toml"));
  fireEvent.click(screen.getByRole("tab", { name: "config.toml" }));
  const area = await editor("config.toml");
  expect(area.value).toBe("[desktop]");
  await act(async () => {
    finishOld({ content: "[covel.story]", digest: "llm-digest", exists: true });
  });
  expect(area.value).toBe("[desktop]");
  mocks.save.mockResolvedValue({
    content: "[desktop]\nport = 3001",
    digest: "next-digest",
  });
  fireEvent.change(area, { target: { value: "[desktop]\nport = 3001" } });
  save();
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(
      "config.toml",
      "[desktop]\nport = 3001",
      "config-digest",
    ),
  );
});

it("rejects a stale whole-settings edit instead of deleting another window's values", async () => {
  render(<RawConfigPane />);
  const area = await editor("Settings (JSON)");
  fireEvent.change(area, {
    target: { value: JSON.stringify({ "ui.scheme": "light" }) },
  });
  await act(async () => {
    await mocks.store.set("concurrent", "Keep this");
  });
  save();
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /changed|conflict/i,
  );
  expect(mocks.store.get("concurrent")).toBe("Keep this");
  expect(mocks.store.get("ui.scheme")).toBe("dark");
  expect(mocks.store.get("extra")).toBe(1);
});

it("preserves a conflicting file draft and its baseline until explicitly reloaded", async () => {
  mocks.files = [
    {
      name: "llm.toml",
      path: "/etc/llm.toml",
      exists: true,
      applies: "reload",
    },
  ];
  mocks.read.mockResolvedValue({
    content: "[covel.story]",
    digest: "old-digest",
    exists: true,
  });
  mocks.save.mockRejectedValue(
    new ApiError(
      409,
      "/api/config/raw",
      JSON.stringify({
        error: "File changed",
        code: "config_file_changed",
      }),
    ),
  );
  render(<RawConfigPane />);
  fireEvent.click(await screen.findByRole("tab", { name: "llm.toml" }));
  const area = await editor("llm.toml");
  fireEvent.change(area, { target: { value: "[covel.plot]" } });
  save();
  await screen.findByRole("alert");
  expect(area.value).toBe("[covel.plot]");
  expect(mocks.save).toHaveBeenLastCalledWith(
    "llm.toml",
    "[covel.plot]",
    "old-digest",
  );
  expect(mocks.boot).not.toHaveBeenCalled();
  mocks.read.mockResolvedValue({
    content: "[covel.utility]",
    digest: "current-digest",
    exists: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Read again" }));
  await waitFor(() => expect(area.value).toBe("[covel.utility]"));
  fireEvent.change(area, { target: { value: "[covel.plot]" } });
  save();
  await waitFor(() =>
    expect(mocks.save).toHaveBeenLastCalledWith(
      "llm.toml",
      "[covel.plot]",
      "current-digest",
    ),
  );
});
