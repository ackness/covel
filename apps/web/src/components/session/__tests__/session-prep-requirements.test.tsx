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

// What the plugin plan and the world-data check report for this world.
const prep = vi.hoisted(() => ({
  unmetRequirements: [] as unknown[],
  preflight: null as unknown,
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
  useSlotConfig: () => ({ resolvedSlots: [], refresh: vi.fn() }),
}));
vi.mock("../session-prep/use-plugin-selection.js", () => ({
  usePluginSelection: () => ({
    enabledPluginIds: ["narrator"],
    requestedPluginIds: ["narrator"],
    excludedPluginIds: [],
    enabledPluginSummaries: [],
    selectedPluginIdSet: new Set(),
    pluginPlan: {},
    pluginPlanLoading: false,
    pluginPlanError: null,
    missingPluginIds: [],
    unmetRequirements: prep.unmetRequirements,
    dependentsOff: [],
  }),
}));
vi.mock("../session-prep/use-world-data-preflight.js", () => ({
  useWorldDataPreflight: () => ({ worldDataPreflight: prep.preflight }),
}));
vi.mock("../session-prep/use-prep-runtime-bindings.js", () => ({
  usePrepRuntimeBindings: () => ({ bindingState: {} }),
}));
vi.mock("@/settings/SettingsDialog.js", () => ({ SettingsDialog: () => null }));
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
  invalidateAllWorldRecords();
  primeWorldRecord({ ...world, lore: "A barrow under the hill." });
  await i18n.changeLanguage("en-US");
  vi.mocked(api.getWorldOverlay).mockResolvedValue(null);
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
});
