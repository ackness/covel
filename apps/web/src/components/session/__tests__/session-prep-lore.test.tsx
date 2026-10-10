import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import * as api from "@/services/api.js";
import {
  invalidateAllWorldRecords,
  primeWorldRecord,
} from "@/services/world-records.js";
import { SessionPrepScreen } from "../session-prep-screen.js";
import type { SessionPrepScreenProps } from "../session-prep/types.js";

vi.mock("@/services/api.js", () => ({
  getWorldOverlay: vi.fn(),
  setWorldOverlay: vi.fn(),
  removeWorldOverlay: vi.fn(),
  fetchPluginFlows: vi.fn(async () => ({ steps: [] })),
}));
const getWorld = vi.fn();
vi.mock("@/services/data-service.js", () => ({
  getDataService: () => ({ listSessions: async () => [], getWorld }),
}));
vi.mock("@/hooks/use-slot-config.js", () => ({
  useSlotConfig: () => ({ resolvedSlots: [], refresh: vi.fn() }),
}));
vi.mock("../session-prep/use-plugin-selection.js", () => ({
  usePluginSelection: () => ({
    selectedPluginIds: ["fixture-plugin"],
    requestedPluginIds: ["fixture-plugin"],
    excludedPluginIds: [],
    selectedPluginSummaries: [],
    selectedPluginIdSet: new Set(),
    pluginPlan: {},
    pluginPlanLoading: false,
    pluginPlanError: null,
    missingPluginIds: [],
    unmetRequirements: [],
  }),
}));
vi.mock("../session-prep/use-world-data-preflight.js", () => ({
  useWorldDataPreflight: () => ({}),
}));
vi.mock("../session-prep/use-prep-runtime-bindings.js", () => ({
  usePrepRuntimeBindings: () => ({ bindingState: {} }),
}));
vi.mock("@/settings/SettingsDialog.js", () => ({ SettingsDialog: () => null }));
vi.mock("../session-prep/world-info-card.js", () => ({
  WorldInfoCard: () => null,
}));
vi.mock("../session-prep/session-history-card.js", () => ({
  SessionHistoryCard: () => null,
}));
vi.mock("../session-prep/dimension-actions.js", () => ({
  DimensionActions: () => null,
}));
vi.mock("../session-prep/models-card.js", () => ({ ModelsCard: () => null }));
vi.mock("../session-prep/plugin-selection-card.js", () => ({
  PluginSelectionCard: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// The full record, which the screen reads its lore from; the screen's prop is
// the summary the list carries.
const fullWorld = {
  id: "world-a",
  name: "World A",
  description: "",
  lore: "Original A",
  createdAt: "2026-01-01",
};
const { lore: _lore, ...world } = fullWorld;
function props(
  overrides: Partial<SessionPrepScreenProps> = {},
): SessionPrepScreenProps {
  return {
    world,
    plugins: [],
    presets: [],
    onBack: vi.fn(),
    onStart: vi.fn(),
    onResume: vi.fn(),
    onDeleteSession: vi.fn(),
    settingsOpen: false,
    onSettingsOpenChange: vi.fn(),
    ...overrides,
  };
}
function openLore() {
  fireEvent.click(screen.getByRole("button", { name: /World Document/ }));
  return screen.getByRole("textbox", { name: "World Document" });
}

beforeEach(async () => {
  vi.clearAllMocks();
  invalidateAllWorldRecords();
  primeWorldRecord(fullWorld);
  await i18n.changeLanguage("en-US");
  vi.mocked(api.getWorldOverlay).mockResolvedValue(null);
  vi.mocked(api.setWorldOverlay).mockResolvedValue(undefined);
  vi.mocked(api.removeWorldOverlay).mockResolvedValue(undefined);
});

describe("session prep narrator-only lore", () => {
  const marked =
    "A village.\n\n<!-- narrator-only -->\n\nThe keeper put the lamp out.\n\n<!-- /narrator-only -->\n\nRain.";

  it("shows the player-visible lore and starts with the whole text", async () => {
    const onStart = vi.fn();
    primeWorldRecord({ ...fullWorld, lore: marked });
    render(<SessionPrepScreen {...props({ onStart })} />);
    const input = openLore() as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe("A village.\n\nRain."));
    fireEvent.click(screen.getAllByRole("button", { name: "Start Game" })[0]!);
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(onStart.mock.calls[0]![1]).toBe(marked);
  });

  it("keeps the narrator-only blocks in the draft of an edited lore", async () => {
    primeWorldRecord({ ...fullWorld, lore: marked });
    render(<SessionPrepScreen {...props()} />);
    const input = openLore() as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "A town." } });
    expect(input.value).toBe("A town.");
    const saved = vi.mocked(api.setWorldOverlay).mock.calls.at(-1)![1].lore;
    expect(saved).toContain("A town.");
    expect(saved).toContain("The keeper put the lamp out.");
    expect(saved).toContain("<!-- narrator-only -->");
    // Typing the visible lore back is the original again, not a draft.
    fireEvent.change(input, { target: { value: "A village.\n\nRain." } });
    expect(api.removeWorldOverlay).toHaveBeenCalledWith("world-a");
  });
});

describe("session prep full record", () => {
  it("does not start while the full record loads, and never with an empty lore", async () => {
    const read = deferred<typeof fullWorld | null>();
    invalidateAllWorldRecords();
    getWorld.mockReturnValueOnce(read.promise);
    const onStart = vi.fn();
    render(<SessionPrepScreen {...props({ onStart })} />);
    // The header paints from the summary at once.
    expect(screen.getAllByText("World A").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Start Game" })[0]!);
    expect(onStart).not.toHaveBeenCalled();
    await act(async () => read.resolve(fullWorld));
    await waitFor(() =>
      expect((openLore() as HTMLTextAreaElement).value).toBe("Original A"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Start Game" })[0]!);
    expect(onStart).toHaveBeenCalledWith(["fixture-plugin"], "Original A", []);
  });
});

describe("session prep lore ownership", () => {
  it("keeps a reset when the original read completes later", async () => {
    const read = deferred<api.WorldOverlay | null>();
    vi.mocked(api.getWorldOverlay).mockReturnValueOnce(read.promise);
    render(<SessionPrepScreen {...props()} />);
    const input = openLore();
    fireEvent.change(input, { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to original" }));
    await act(async () =>
      read.resolve({ lore: "Old draft", updatedAt: "2026-01-01" }),
    );
    expect((input as HTMLTextAreaElement).value).toBe("Original A");
    expect(api.removeWorldOverlay).toHaveBeenCalledWith("world-a");
  });

  it("blocks creation while reading an unknown draft and retries a read failure", async () => {
    const read = deferred<api.WorldOverlay | null>();
    vi.mocked(api.getWorldOverlay).mockReturnValueOnce(read.promise);
    const onStart = vi.fn();
    render(<SessionPrepScreen {...props({ onStart })} />);
    const start = screen.getAllByRole("button", {
      name: "Start Game",
    })[0]!;
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => read.reject(new Error("Sensitive draft content")));
    expect(screen.getByRole("alert").textContent).toContain("Could not load");
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();
    vi.mocked(api.getWorldOverlay).mockResolvedValue({
      lore: "Recovered draft",
      updatedAt: "2026-01-01",
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Retry" })),
    );
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(
      ["fixture-plugin"],
      "Recovered draft",
      [],
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Sensitive");
    warn.mockRestore();
  });

  it("keeps failed draft writes retryable while starting with the displayed text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onStart = vi.fn();
    render(<SessionPrepScreen {...props({ onStart })} />);
    const input = openLore();
    await act(async () => {});
    vi.mocked(api.setWorldOverlay).mockRejectedValueOnce(
      new Error("Private draft"),
    );
    await act(async () =>
      fireEvent.change(input, { target: { value: "Latest draft" } }),
    );
    expect(screen.getByRole("alert").textContent).toContain("Draft not saved");
    fireEvent.click(screen.getAllByRole("button", { name: "Start Game" })[0]!);
    expect(onStart).toHaveBeenCalledWith(
      ["fixture-plugin"],
      "Latest draft",
      [],
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Retry" })),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.setWorldOverlay).toHaveBeenLastCalledWith(
      "world-a",
      expect.objectContaining({ lore: "Latest draft" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Private");
    warn.mockRestore();
  });

  it("ignores an older write failure after a newer save succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const write = deferred<void>();
    render(<SessionPrepScreen {...props()} />);
    const input = openLore();
    await act(async () => {});
    vi.mocked(api.setWorldOverlay).mockReturnValueOnce(write.promise);
    fireEvent.change(input, { target: { value: "Older" } });
    await act(async () =>
      fireEvent.change(input, { target: { value: "Newer" } }),
    );
    await act(async () => write.reject(new Error("Old failure")));
    expect((input as HTMLTextAreaElement).value).toBe("Newer");
    expect(screen.queryByRole("alert")).toBeNull();
    warn.mockRestore();
  });

  it("keeps an edit when the initial draft read arrives late", async () => {
    const read = deferred<api.WorldOverlay | null>();
    vi.mocked(api.getWorldOverlay).mockReturnValueOnce(read.promise);
    render(<SessionPrepScreen {...props()} />);
    const input = openLore();
    fireEvent.change(input, { target: { value: "Current edit" } });
    await act(async () =>
      read.resolve({ lore: "Old draft", updatedAt: "2026-01-01" }),
    );
    expect((input as HTMLTextAreaElement).value).toBe("Current edit");
  });

  it("restores an explicitly empty draft", async () => {
    vi.mocked(api.getWorldOverlay).mockResolvedValue({
      lore: "",
      updatedAt: "2026-01-01",
    });
    render(<SessionPrepScreen {...props()} />);
    const input = openLore();
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  });

  it("resets to the new world's text and ignores the old world's late read", async () => {
    const read = deferred<api.WorldOverlay | null>();
    vi.mocked(api.getWorldOverlay).mockReturnValueOnce(read.promise);
    primeWorldRecord({ ...fullWorld, id: "world-b", lore: "Original B" });
    const view = render(<SessionPrepScreen {...props()} />);
    const input = openLore();
    view.rerender(
      <SessionPrepScreen {...props({ world: { ...world, id: "world-b" } })} />,
    );
    await act(async () =>
      read.resolve({ lore: "Draft A", updatedAt: "2026-01-01" }),
    );
    expect((input as HTMLTextAreaElement).value).toBe("Original B");
  });

  it("captures the current text at session creation without waiting for draft persistence", async () => {
    const write = deferred<void>();
    vi.mocked(api.setWorldOverlay).mockReturnValueOnce(write.promise);
    const onStart = vi.fn();
    render(<SessionPrepScreen {...props({ onStart })} />);
    const input = openLore();
    await act(async () => {});
    fireEvent.change(input, { target: { value: "Session-specific text" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Start Game" })[0]!);
    expect(onStart).toHaveBeenCalledWith(
      ["fixture-plugin"],
      "Session-specific text",
      [],
    );
    await act(async () => write.resolve());
  });
});
