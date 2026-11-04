import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import * as api from "@/services/api.js";
import {
  invalidateAllWorldRecords,
  primeWorldRecord,
} from "@/services/world-records.js";
import { SessionPrepScreen } from "../session-prep-screen.js";
import { StartPanel } from "../session-prep/start-panel.js";
import { worldPluginPlanFixture } from "./session-prep-fixtures.js";

const prep = vi.hoisted(() => ({
  slots: [] as unknown[],
}));

vi.mock("@/services/api.js", () => ({
  getWorldOverlay: vi.fn(),
  setWorldOverlay: vi.fn(),
  removeWorldOverlay: vi.fn(),
  fetchPluginFlows: vi.fn(async () => ({ steps: [] })),
}));
vi.mock("@/services/data-service.js", () => ({
  getDataService: () => ({
    listSessions: async () => [],
    getWorld: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-slot-config.js", () => ({
  useSlotConfig: () => ({ resolvedSlots: prep.slots, refresh: vi.fn() }),
  formatSlotLabel: (slot: { slotId: string }) => `label:${slot.slotId}`,
}));
vi.mock("../session-prep/use-plugin-selection.js", () => ({
  usePluginSelection: (worldId: string) => ({
    enabledPluginIds: ["fixture-plugin"],
    requestedPluginIds: ["fixture-plugin"],
    excludedPluginIds: [],
    enabledPluginSummaries: [],
    selectedPluginIdSet: new Set(),
    pluginPlan: worldPluginPlanFixture(worldId, {
      requestedPluginIds: ["fixture-plugin"],
      requiredContracts: [],
    }),
    pluginPlanLoading: false,
    pluginPlanError: null,
    missingPluginIds: [],
    unmetRequirements: [],
    dependentsOff: [],
  }),
}));
vi.mock("../session-prep/use-world-data-preflight.js", () => ({
  useWorldDataPreflight: () => ({}),
}));
vi.mock("../session-prep/use-prep-runtime-bindings.js", () => ({
  usePrepRuntimeBindings: () => ({ bindingState: {} }),
}));
vi.mock("@/settings/SettingsDialog.js", () => ({
  SettingsDialog: ({
    open,
    initialKey,
  }: {
    open: boolean;
    initialKey?: string;
  }) => (open ? <div role="dialog">{initialKey}</div> : null),
}));
vi.mock("../session-prep/plugin-selection-card.js", () => ({
  PluginSelectionCard: () => <div data-testid="plugin-picker" />,
}));
vi.mock("../session-prep/dimension-actions.js", () => ({
  DimensionActions: () => <div data-testid="world-state-actions" />,
}));

const world = {
  id: "world-a",
  name: "World A",
  description: "",
  createdAt: "2026-01-01",
};

const usable = {
  slotId: "story",
  presetId: "",
  preset: null,
  label: "story",
  tag: "text",
  hasCredentials: true,
  isAvailable: true,
};

function Screen() {
  const [open, setOpen] = useState(false);
  return (
    <SessionPrepScreen
      world={world}
      plugins={[]}
      presets={[]}
      onBack={vi.fn()}
      onStart={vi.fn()}
      onResume={vi.fn()}
      onDeleteSession={vi.fn()}
      settingsOpen={open}
      onSettingsOpenChange={setOpen}
    />
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  prep.slots = [];
  invalidateAllWorldRecords();
  primeWorldRecord({ ...world, lore: "Lore" });
  await i18n.changeLanguage("en-US");
  vi.mocked(api.getWorldOverlay).mockResolvedValue(null);
});

describe("session prep start screen", () => {
  it("leads with Start and keeps the custom start folded away", () => {
    render(<Screen />);
    const start = screen.getByTestId("start-panel");
    expect(start.querySelector("button")?.textContent).toContain("Start Game");
    expect(screen.queryByTestId("custom-start")).toBeNull();
    expect(screen.queryByTestId("plugin-picker")).toBeNull();
    expect(screen.queryByRole("button", { name: /World Document/ })).toBeNull();
    expect(screen.getByText(/Using the recommended settings/)).toBeTruthy();
  });

  it("opens the world document, world state, plugin picker and checks in one section", async () => {
    render(<Screen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Customize the start" }),
    );
    expect(screen.getByTestId("custom-start")).toBeTruthy();
    expect(screen.getByTestId("plugin-picker")).toBeTruthy();
    expect(screen.getByRole("button", { name: /World Document/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByTestId("custom-start")).toBeNull();
  });

  it("shows the role choice with a hint for each", () => {
    render(<Screen />);
    expect(screen.getByRole("radio", { name: "Player" })).toBeTruthy();
    expect(screen.getByText(/You play the main character/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Spectator" }));
    expect(screen.getByText(/Watch only/)).toBeTruthy();
  });

  it("names the model in one line and opens Settings → Models to change it", async () => {
    prep.slots = [usable];
    render(<Screen />);
    expect(screen.getByTestId("model-line").textContent).toContain(
      "Using: label:story",
    );
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toBe("llm.slots"),
    );
  });

  it("says what is missing and links to the provider settings", async () => {
    prep.slots = [{ ...usable, hasCredentials: false }];
    render(<Screen />);
    expect(screen.getByTestId("model-line").textContent).toContain(
      "no key yet",
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toBe("llm.providers"),
    );
  });

  it("has no models card or model editor of its own", () => {
    prep.slots = [usable];
    render(<Screen />);
    expect(screen.queryByText(/Active Models/i)).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("StartPanel", () => {
  const base = {
    isStarting: false,
    canStart: true,
    onStart: vi.fn(),
    seatRole: "player" as const,
    onSeatRoleChange: vi.fn(),
    model: { kind: "none" } as const,
    onChangeModel: vi.fn(),
    customOpen: false,
    onToggleCustom: vi.fn(),
  };

  it("hides the role choice when only one role is valid", () => {
    render(<StartPanel {...base} roles={["player"]} />);
    expect(screen.queryByTestId("seat-role")).toBeNull();
  });

  it("shows the choice when there are several", () => {
    render(<StartPanel {...base} roles={["player", "host"]} />);
    expect(screen.getByTestId("seat-role")).toBeTruthy();
  });
});
