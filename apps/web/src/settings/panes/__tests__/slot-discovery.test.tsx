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
import { registerProviderKeys } from "../../registry/keys.js";
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
  world: null as unknown,
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
vi.mock("@/settings/store", () => ({
  getSettings: () => mocks.store,
  registerKnownProviders: (ids: readonly string[]) =>
    registerProviderKeys(mocks.store, ids),
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      plugins: mocks.plugins,
      presets: [],
      llmConfig: mocks.llm,
      world: mocks.world,
    },
  }),
}));

beforeEach(async () => {
  mocks.world = null;
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
      requires: [],
      optional: [],
      conflicts: [],
      extensions: [],
      id: "fixture",
      displayName: "Fixture",
      description: "Fixture",
      kind: "plugin",
      source: "builtin",
      hostState: "loaded",
      runtimeCount: 1,
      provides: [],
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
          outputContract: undefined,
          tags: [],
        },
      ],
      languages: { text: ["en"], instructions: ["en"] },
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
  mocks.llm = { ...mocks.llm, slots: { default: mocks.llm.slots.story! } };
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

it("exposes the framework memory role even without server-defined slots", () => {
  mocks.plugins = [];
  mocks.llm = { ...mocks.llm, slots: {} };
  render(<LlmAdvancedPane />);
  const picker = screen.getByRole("combobox", {
    name: i18n.t("settings.selectSlot"),
  }) as HTMLSelectElement;
  expect(picker.value).toBe("memory");
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
    "memory",
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

it("shows the world's default for a setting the player has not set", async () => {
  mocks.world = {
    id: "mistport",
    name: { "en-US": "Mistport" },
    metadata: { pluginSettings: { fixture: { mediaRole: "story" } } },
  };
  const view = () => (
    <PluginSettingsPane
      entries={mocks.store
        .listEntries()
        .filter((entry) => entry.pluginId === "fixture")}
    />
  );
  const { rerender } = render(view());
  const picker = screen.getByRole("combobox", {
    name: "Media role",
  }) as HTMLSelectElement;
  // The manifest default is "image"; this world runs the plugin on "story".
  expect(picker.value).toBe("story");
  expect(
    screen.getByText("Using the default of the world “Mistport”."),
  ).toBeTruthy();

  await act(async () => {
    await mocks.store.set("plugin.fixture.mediaRole", "image");
  });
  rerender(view());
  expect(picker.value).toBe("image");
  expect(screen.queryByText(/Using the default of the world/)).toBeNull();
});
