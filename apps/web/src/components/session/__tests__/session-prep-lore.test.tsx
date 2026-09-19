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
import { SessionPrepScreen } from "../session-prep-screen.js";
import type { SessionPrepScreenProps } from "../session-prep/types.js";

vi.mock("@/services/api.js", () => ({
  getWorldOverlay: vi.fn(),
  setWorldOverlay: vi.fn(),
  removeWorldOverlay: vi.fn(),
  fetchPluginFlows: vi.fn(async () => ({ steps: [] })),
}));
vi.mock("@/services/data-service.js", () => ({
  getDataService: () => ({ listSessions: async () => [] }),
}));
vi.mock("@/hooks/use-slot-config.js", () => ({
  useSlotConfig: () => ({ resolvedSlots: [], refresh: vi.fn() }),
}));
vi.mock("../session-prep/use-plugin-selection.js", () => ({
  usePluginSelection: () => ({
    selectedPluginIds: ["fixture-plugin"],
    selectedPluginSummaries: [],
    selectedPluginIdSet: new Set(),
    pluginPlan: {},
    pluginPlanLoading: false,
    pluginPlanError: null,
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

const world = {
  id: "world-a",
  name: "World A",
  description: "",
  lore: "Original A",
  createdAt: "2026-01-01",
};
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
  await i18n.changeLanguage("en-US");
  vi.mocked(api.getWorldOverlay).mockResolvedValue(null);
  vi.mocked(api.setWorldOverlay).mockResolvedValue(undefined);
  vi.mocked(api.removeWorldOverlay).mockResolvedValue(undefined);
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
    expect(onStart).toHaveBeenCalledWith(["fixture-plugin"], "Recovered draft");
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
    expect(onStart).toHaveBeenCalledWith(["fixture-plugin"], "Latest draft");
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
    const view = render(<SessionPrepScreen {...props()} />);
    const input = openLore();
    view.rerender(
      <SessionPrepScreen
        {...props({ world: { ...world, id: "world-b", lore: "Original B" } })}
      />,
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
    );
    await act(async () => write.resolve());
  });
});
