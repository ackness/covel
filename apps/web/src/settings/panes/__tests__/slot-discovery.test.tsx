import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@covel/settings";
import type { PluginSummary, LlmConfigResponse } from "@/services/api.js";
import i18n from "@/i18n";
import { registerLlmSettings } from "../../registry/llm.js";
import { registerPluginUserSettings } from "../../registry/plugin.js";
import { useLlmSlotIds } from "../use-llm-slot-ids.js";
import { PluginSettingsPane } from "../PluginSettingsPane.js";
import { LlmAdvancedPane } from "../LlmAdvancedPane.js";

vi.mock("../use-model-capability.js", () => ({
  useModelCapability: () => undefined,
}));

const mocks = vi.hoisted(() => ({
  store: null as unknown as SettingsStore,
  plugins: [] as PluginSummary[],
  llm: {
    configured: true,
    providers: [],
    slots: {
      story: {
        provider: "fixture",
        model: "story-model",
        tag: "text",
        protocol: "openai-chat-v1",
      },
    },
  } as LlmConfigResponse,
}));
vi.mock("@/settings/store", () => ({ getSettings: () => mocks.store }));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: { plugins: mocks.plugins, presets: [], llmConfig: mocks.llm },
  }),
}));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  mocks.store = new SettingsStore({
    load: async () => ({}),
    save: async () => undefined,
    loadSecrets: async () => ({}),
    saveSecrets: async () => undefined,
  });
  registerLlmSettings(mocks.store);
  mocks.llm = {
    configured: true,
    providers: [],
    slots: {
      story: {
        provider: "fixture",
        model: "story-model",
        tag: "text",
        protocol: "openai-chat-v1",
      },
    },
  };
  mocks.plugins = [
    {
      id: "fixture",
      displayName: "Fixture",
      description: "Fixture",
      pluginType: "plugin",
      source: "builtin",
      status: "registered",
      runtimeCount: 1,
      capabilities: [],
      tags: [],
      tools: [],
      runtimes: [
        {
          id: "fixture/agent",
          model: "analysis",
          runtimeType: "agent",
          trigger: { type: "auto" },
          execution: "sync",
          turnCompletion: { mode: "await" },
          outputKind: "plugin",
          capabilities: [],
          tags: [],
        },
      ],
      userSettings: [
        {
          key: "mediaRole",
          type: "slot",
          label: "Media role",
          default: "image",
        },
      ],
    },
  ];
  registerPluginUserSettings(
    mocks.store,
    "fixture",
    mocks.plugins[0]!.userSettings,
    ["story"],
  );
  await mocks.store.init();
});

it("edits saved parameters for a default-only server configuration", async () => {
  mocks.plugins = [];
  mocks.llm = { ...mocks.llm, slots: { default: mocks.llm.slots.story } };
  await mocks.store.set("llm.paramOverrides", {
    default: { temperature: 0.4 },
  });
  render(<LlmAdvancedPane />);
  expect(
    (
      screen.getByRole("combobox", {
        name: i18n.t("settings.selectSlot"),
      }) as HTMLSelectElement
    ).value,
  ).toBe("default");
  const input = screen.getByRole("spinbutton", { name: "Temperature" });
  expect((input as HTMLInputElement).value).toBe("0.4");
  fireEvent.change(input, { target: { value: "0.7" } });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(mocks.store.get("llm.paramOverrides")).toEqual({
      default: { temperature: 0.7 },
    }),
  );
});

it("disables generation inputs when no role is available", () => {
  mocks.plugins = [];
  mocks.llm = { ...mocks.llm, slots: {} };
  render(<LlmAdvancedPane />);
  for (const input of screen.getAllByRole("spinbutton"))
    expect(input.matches(":disabled")).toBe(true);
  expect(mocks.store.get("llm.paramOverrides")).toEqual({});
});

it("keeps saved, runtime and user-selected roles in both settings panes after live edits", async () => {
  await mocks.store.set("llm.paramOverrides", {
    archived: { temperature: 0.5 },
  });
  const { result } = renderHook(useLlmSlotIds);
  expect(result.current.slots).toEqual([
    "story",
    "analysis",
    "image",
    "archived",
  ]);
  await act(async () => {
    await mocks.store.set("llm.slotConfig", {
      custom: { modelRef: "fixture-model" },
    });
    await mocks.store.set("plugin.fixture.mediaRole", "image-custom");
  });
  expect(result.current.slots).toEqual(
    expect.arrayContaining(["custom", "image-custom", "archived", "analysis"]),
  );
});

it("refreshes plugin slot choices without rebooting and retains an unavailable saved value", async () => {
  await mocks.store.set("plugin.fixture.mediaRole", "removed-slot");
  render(
    <PluginSettingsPane
      entries={mocks.store
        .listEntries()
        .filter((entry) => entry.pluginId === "fixture")}
    />,
  );
  const picker = screen.getByRole("combobox", {
    name: "Media role",
  }) as HTMLSelectElement;
  expect(picker.value).toBe("removed-slot");
  await act(async () => {
    await mocks.store.set("llm.slotConfig", {
      newlyAdded: { modelRef: "fixture-model" },
    });
  });
  await waitFor(() =>
    expect(Array.from(picker.options).map((option) => option.value)).toContain(
      "newlyAdded",
    ),
  );
  expect(picker.value).toBe("removed-slot");
});
