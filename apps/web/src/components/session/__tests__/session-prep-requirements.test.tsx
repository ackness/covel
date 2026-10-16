import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import * as api from "@/services/api.js";
import {
  invalidateAllWorldRecords,
  primeWorldRecord,
} from "@/services/world-records.js";
import { SessionPrepScreen } from "../session-prep-screen.js";
import type { SessionPrepScreenProps } from "../session-prep/types.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type { sessionModelUses } from "../provider-failure-notice.js";

// What the plugin plan and the world-data check report for this world.
const prep = vi.hoisted(() => ({
  unmetRequirements: [] as unknown[],
  preflight: null as unknown,
  conflict: null as readonly string[] | null,
  turnOffPlugins: (() => {}) as (ids: readonly string[]) => void,
  slots: [] as ResolvedSlot[],
  plugins: [] as Parameters<typeof sessionModelUses>[0],
  bindings: {} as Record<string, string>,
  refresh: vi.fn(),
}));

vi.mock("@/services/api.js", () => ({
  getWorldOverlay: vi.fn(),
  setWorldOverlay: vi.fn(),
  removeWorldOverlay: vi.fn(),
  fetchPluginFlows: vi.fn(async () => ({ steps: [] })),
}));
vi.mock("@/services/data-service.js", () => ({
  getDataService: () => ({
    listSessions: vi.fn(async () => []),
    getWorld: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-slot-config.js", () => ({
  useSlotConfig: () => ({ resolvedSlots: prep.slots, refresh: prep.refresh }),
}));
vi.mock("../session-prep/use-plugin-selection.js", () => ({
  usePluginSelection: () => ({
    enabledPluginIds: ["narrator"],
    requestedPluginIds: ["narrator"],
    excludedPluginIds: [],
    enabledPluginSummaries: prep.plugins,
    selectedPluginIdSet: new Set(),
    pluginPlan: {},
    pluginPlanLoading: false,
    pluginPlanError: null,
    missingPluginIds: [],
    unmetRequirements: prep.unmetRequirements,
    dependentsOff: [],
    turnOffPlugins: prep.turnOffPlugins,
  }),
}));
vi.mock("../session-prep/use-world-data-preflight.js", () => ({
  useWorldDataPreflight: () => ({
    worldDataPreflight: prep.preflight,
    dimensionProviderConflict: prep.conflict,
  }),
}));
vi.mock("../session-prep/use-prep-runtime-bindings.js", () => ({
  usePrepRuntimeBindings: () => ({ bindingState: { bindings: prep.bindings } }),
}));
vi.mock("@/settings/SettingsDialog.js", () => ({
  SettingsDialog: ({
    open,
    initialKey,
    onOpenChange,
  }: {
    open: boolean;
    initialKey?: string;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <button
        data-testid="settings"
        data-page={initialKey}
        onClick={() => onOpenChange(false)}
      >
        Close settings
      </button>
    ) : null,
}));
vi.mock("../session-prep/dimension-actions.js", () => ({
  DimensionActions: () => null,
}));
vi.mock("../session-prep/models-card.js", () => ({ ModelsCard: () => null }));
vi.mock("../session-prep/plugin-selection-card.js", () => ({
  PluginSelectionCard: () => null,
}));

const world = {
  id: "lantern-barrow",
  name: "Lantern Barrow",
  description: "",
  createdAt: "2026-10-15",
};

function props(onStart = vi.fn()): SessionPrepScreenProps {
  return {
    world,
    plugins: [],
    presets: [],
    onBack: vi.fn(),
    onStart,
    onResume: vi.fn(),
    onDeleteSession: vi.fn(),
    settingsOpen: false,
    onSettingsOpenChange: vi.fn(),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  prep.unmetRequirements = [];
  prep.preflight = null;
  prep.conflict = null;
  prep.turnOffPlugins = vi.fn();
  prep.slots = [];
  prep.plugins = [];
  prep.bindings = {};
  invalidateAllWorldRecords();
  primeWorldRecord({ ...world, lore: "A barrow under the hill." });
  await i18n.changeLanguage("en-US");
  vi.mocked(api.getWorldOverlay).mockResolvedValue(null);
});

const textSlot = (
  slotId: string,
  hasCredentials?: boolean,
  provider = "deepseek",
): ResolvedSlot => ({
  slotId,
  label: slotId,
  tag: "text",
  presetId: "",
  preset: null,
  serverProvider: provider,
  serverModel: "model",
  isAvailable: true,
  hasCredentials,
});

function useTextModels(...models: string[]) {
  prep.plugins = [
    {
      hostState: "loaded",
      runtimes: models.map((model) => ({
        id: `fixture/${model}`,
        model,
        runtimeType: "agent",
        trigger: { type: "auto" },
        execution: "sync",
        turnCompletion: { mode: "await" },
        outputKind: "system",
      })),
    },
  ];
}

async function clickStart(index = 0) {
  const button = screen.getAllByRole("button", { name: "Start Game" })[index];
  expect(button).toBeDefined();
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button!);
}

describe("starting without model credentials", () => {
  it.each([0, 1])(
    "confirms from start button %s and still lets the player start",
    async (index) => {
      useTextModels("story", "plugin");
      prep.slots = [textSlot("story", false)];
      const onStart = vi.fn();
      render(<SessionPrepScreen {...props(onStart)} />);
      await clickStart(index);
      expect(screen.getByRole("dialog").textContent).toContain(
        "No API key is configured for DeepSeek. Story and Plugin tasks may fail.",
      );
      expect(onStart).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
      await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it.each(["unused", "image", "local", "unknown", "override"])(
    "does not confirm for %s credentials",
    async (scenario) => {
      useTextModels("story");
      prep.slots = [textSlot("story", true)];
      if (scenario === "unused") prep.slots.push(textSlot("unused", false));
      if (scenario === "image")
        prep.slots.push({ ...textSlot("image", false), tag: "image" });
      if (scenario === "local")
        prep.slots = [textSlot("story", true, "ollama")];
      if (scenario === "unknown") prep.slots = [textSlot("story")];
      if (scenario === "override") {
        prep.slots = [
          textSlot("story", false),
          textSlot("local", true, "ollama"),
        ];
        prep.bindings = { "fixture/story": "local" };
      }
      const onStart = vi.fn();
      render(<SessionPrepScreen {...props(onStart)} />);
      await clickStart();
      await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("opens provider settings and checks refreshed credentials on the next start", async () => {
    useTextModels("story");
    prep.slots = [textSlot("story", false)];
    const initial = props();
    const view = render(<SessionPrepScreen {...initial} />);
    await clickStart();
    fireEvent.click(screen.getByRole("button", { name: "Add API key" }));
    expect(initial.onSettingsOpenChange).toHaveBeenCalledWith(true);
    expect(initial.onStart).not.toHaveBeenCalled();
    view.rerender(<SessionPrepScreen {...initial} settingsOpen />);
    expect(screen.getByTestId("settings").getAttribute("data-page")).toBe(
      "llm.providers",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(prep.refresh).toHaveBeenCalled();
    view.rerender(<SessionPrepScreen {...initial} />);
    // Closing settings without entering a key does not remember a bypass.
    await clickStart();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add API key" }));
    view.rerender(<SessionPrepScreen {...initial} settingsOpen />);
    prep.slots = [textSlot("story", true)];
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    view.rerender(<SessionPrepScreen {...initial} />);
    await clickStart();
    await waitFor(() => expect(initial.onStart).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names each missing provider and dismisses without starting", async () => {
    useTextModels("story", "plugin");
    prep.slots = [
      textSlot("story", false),
      textSlot("plugin", false, "openai"),
    ];
    const initial = props();
    render(<SessionPrepScreen {...initial} />);
    await clickStart();
    expect(
      screen.getByText(
        "No API key is configured for DeepSeek. Story may fail.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "No API key is configured for OpenAI. Plugin tasks may fail.",
      ),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(initial.onStart).not.toHaveBeenCalled();
  });
});

describe("session prep when the world relies on something missing", () => {
  it("names a required contract without a provider and still starts", async () => {
    prep.unmetRequirements = [
      { contract: "action-check@1", code: "missing-provider" },
    ];
    const onStart = vi.fn();
    render(<SessionPrepScreen {...props(onStart)} />);

    const notice = screen.getByTestId("unmet-world-requirements");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(
      "This world will run without something it relies on",
    );
    expect(notice.textContent).toContain("action-check@1");

    // Once the world record is read, nothing holds the start back.
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Start Game" })[0],
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Start Game" })[0]!);
    await waitFor(() => expect(onStart).toHaveBeenCalled());
  });

  it("says the world's dimensions are left out when no plugin keeps them", () => {
    prep.preflight = {
      imported: true,
      planned: 0,
      targets: [],
      diagnostics: [
        {
          level: "warning",
          code: "dimension-provider-missing",
          message: "No active plugin provides world.dimensions@1",
        },
      ],
    };
    render(<SessionPrepScreen {...props()} />);

    expect(
      screen.getByTestId("unmet-world-requirements").textContent,
    ).toContain("so the game starts without them");
  });

  it("asks the player to keep one of several dimension providers before starting", async () => {
    const startButtons = () =>
      screen.getAllByRole("button", { name: "Start Game" });
    const { rerender } = render(<SessionPrepScreen {...props()} />);
    await waitFor(() =>
      expect(startButtons()[0]).toHaveProperty("disabled", false),
    );

    prep.conflict = ["world-init", "rival-dimensions"];
    rerender(<SessionPrepScreen {...props()} />);
    const notice = screen.getByTestId("dimension-provider-conflict");
    expect(notice.textContent).toContain(
      "Choose the plugin that keeps this world's dimensions",
    );
    expect(notice.textContent).toContain("world-init and rival-dimensions");
    // The server would refuse the start until one is kept.
    for (const button of startButtons())
      expect(button).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Keep world-init" }));
    expect(prep.turnOffPlugins).toHaveBeenCalledWith(["rival-dimensions"]);
  });
});
