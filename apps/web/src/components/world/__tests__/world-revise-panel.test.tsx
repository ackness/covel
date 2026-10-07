import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { GenerateWorldEvent, WorldRecord } from "@/services/api.js";

const api = vi.hoisted(() => ({ reviseWorld: vi.fn() }));
const dataService = vi.hoisted(() => ({ saveGeneratedWorld: vi.fn() }));
const storage = vi.hoisted(() => ({ mode: "server" }));

vi.mock("@/services/api.js", () => api);
vi.mock("@/services/data-service.js", () => ({
  getDataService: vi.fn(() => dataService),
  getStorageMode: vi.fn(() => storage.mode),
}));

const { WorldRevisePanel, isWorldRevisable } =
  await import("../world-revise-panel.js");

const world = {
  id: "clockwork",
  name: "Clockwork",
  description: "A city of clocks.",
  metadata: { source: "generated-file", generated: true },
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
} as WorldRecord;

/** Start a revision and give back the handler the panel listens with. */
function startRevision(onRevised = vi.fn()) {
  let onEvent: ((event: GenerateWorldEvent) => void) | undefined;
  api.reviseWorld.mockImplementation(
    (_id: string, _text: string, next: (event: GenerateWorldEvent) => void) => {
      onEvent = next;
      return new AbortController();
    },
  );
  render(<WorldRevisePanel world={world} onRevised={onRevised} />);
  fireEvent.change(screen.getByRole("textbox", { name: "What to change" }), {
    target: { value: "  add a rival  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply the change" }));
  return { onRevised, emit: (event: GenerateWorldEvent) => onEvent!(event) };
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storage.mode = "server";
});

describe("WorldRevisePanel", () => {
  it("offers revision for worlds created in the app only", () => {
    const from = (metadata: Record<string, unknown>) =>
      ({ ...world, metadata }) as WorldRecord;
    // Files on the server, a store, this browser: the generator's mark counts.
    for (const source of ["file", "server-store", "browser-indexeddb"])
      expect(isWorldRevisable(from({ source, generated: true }))).toBe(true);
    // A world package made by hand or installed is changed in its files.
    expect(isWorldRevisable(from({ source: "file" }))).toBe(false);
    expect(isWorldRevisable(from({ source: "generated-file" }))).toBe(false);
  });

  it("sends the request and hands the revised world to its caller", async () => {
    const { onRevised, emit } = startRevision();
    expect(api.reviseWorld).toHaveBeenCalledWith(
      "clockwork",
      "add a rival",
      expect.any(Function),
      expect.any(Function),
      undefined,
    );

    const revised = { ...world, lore: "A rival appears." } as WorldRecord;
    act(() => emit({ type: "progress", phase: "validating" }));
    act(() =>
      emit({
        type: "done",
        world: revised,
        warnings: ["one part was dropped"],
      }),
    );

    await waitFor(() => expect(onRevised).toHaveBeenCalledWith(revised));
    expect(dataService.saveGeneratedWorld).not.toHaveBeenCalled();
    // The request is done: the box is empty for the next one.
    expect(
      (
        screen.getByRole("textbox", {
          name: "What to change",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    expect(screen.getByText("one part was dropped")).toBeTruthy();
  });

  it("sends a browser world with the request and keeps the result in the browser", async () => {
    storage.mode = "local";
    const saved = { ...world, lore: "Saved in the browser." } as WorldRecord;
    dataService.saveGeneratedWorld.mockResolvedValue(saved);
    const { onRevised, emit } = startRevision();
    expect(api.reviseWorld.mock.calls[0]![4]).toEqual({ world });

    act(() => emit({ type: "done", world: { ...world, lore: "Revised." } }));

    await waitFor(() => expect(onRevised).toHaveBeenCalledWith(saved));
    expect(dataService.saveGeneratedWorld).toHaveBeenCalledWith(
      { ...world, lore: "Revised." },
      { expectedWorld: world },
    );
  });

  it("keeps the request and reports a local revision conflict without publishing it", async () => {
    storage.mode = "local";
    dataService.saveGeneratedWorld.mockRejectedValueOnce(
      new Error("World changed during revision; reload it before trying again"),
    );
    const { onRevised, emit } = startRevision();
    act(() =>
      emit({ type: "done", world: { ...world, lore: "Stale result" } }),
    );
    expect(
      await screen.findByText(/World changed during revision/),
    ).toBeTruthy();
    expect(onRevised).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "  add a rival  ",
    );
  });

  it("says that a revision removes the world's other editions", () => {
    const note = /A revision removes them/;
    const view = render(<WorldRevisePanel world={world} onRevised={vi.fn()} />);
    expect(screen.queryByText(note)).toBeNull();

    view.rerender(
      <WorldRevisePanel
        world={
          {
            ...world,
            locale: "en-US",
            metadata: {
              ...world.metadata,
              supportedLocales: ["en-US", "zh-CN"],
            },
          } as WorldRecord
        }
        onRevised={vi.fn()}
      />,
    );
    expect(screen.getByText(note)).toBeTruthy();
  });

  it("shows why a revision failed and keeps the request for another try", async () => {
    const { onRevised, emit } = startRevision();
    act(() => emit({ type: "error", message: "The package was not valid." }));

    expect(await screen.findByText("The package was not valid.")).toBeTruthy();
    expect(onRevised).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("textbox", {
          name: "What to change",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("  add a rival  ");
  });
});
