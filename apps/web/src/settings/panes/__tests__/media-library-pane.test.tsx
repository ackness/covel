import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type {
  MediaLibraryItem,
  MediaLibraryPage,
} from "@/services/api/media.js";
import { ApiError } from "@/services/api/request.js";

const api = vi.hoisted(() => ({
  listMediaLibrary: vi.fn(),
  deleteMediaLibrary: vi.fn(),
}));

vi.mock("@/services/api/media.js", () => api);
vi.mock("@/services/api/worlds.js", () => ({
  listWorlds: vi.fn(async () => [{ id: "harbor", name: "Lantern Harbor" }]),
}));
vi.mock("@/lib/media-cache.js", () => ({
  deleteCachedMedia: vi.fn(async () => undefined),
}));

const { MediaLibraryPane } = await import("../MediaLibraryPane.js");

const MB = 1024 * 1024;

function item(
  id: string,
  overrides: Partial<MediaLibraryItem> = {},
): MediaLibraryItem {
  return {
    id,
    mime: "image/png",
    kind: "image",
    size: MB,
    createdAt: "2026-10-01T10:00:00.000Z",
    name: `${id}.png`,
    usage: "unused",
    usedBy: [],
    url: `/api/media/${id}?token=t`,
    ...overrides,
  };
}

function page(items: readonly MediaLibraryItem[]): MediaLibraryPage {
  const unused = items.filter((entry) => entry.usage === "unused");
  return {
    items: [...items],
    total: items.length,
    offset: 0,
    limit: 48,
    sessions: [
      {
        id: "sess-1",
        worldId: "harbor",
        completedPlayerTurns: 12,
        createdAt: "2026-09-30T08:00:00.000Z",
      },
    ],
    totals: {
      count: items.length,
      bytes: items.reduce((sum, entry) => sum + entry.size, 0),
      unusedCount: unused.length,
      unusedBytes: unused.reduce((sum, entry) => sum + entry.size, 0),
    },
    scan: { complete: true },
  };
}

const USED = item("used", { usage: "used", usedBy: ["sess-1"] });

describe("MediaLibraryPane", () => {
  const confirm = vi.fn<(message?: string) => boolean>();

  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    api.listMediaLibrary.mockReset();
    api.deleteMediaLibrary.mockReset();
    api.deleteMediaLibrary.mockResolvedValue({
      deletedIds: [],
      bytesDeleted: 0,
      skipped: [],
    });
    // No confirm host is mounted, so a prompt reaches the native dialog.
    confirm.mockReset().mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("deletes nothing until the player confirms a choice", async () => {
    api.listMediaLibrary.mockResolvedValue(page([item("a"), item("b"), USED]));
    confirm.mockReturnValue(false);
    render(<MediaLibraryPane />);

    await screen.findByText("Stored items: 3 · 3 MB");
    expect(
      screen.getByText("Not used by any session: 2 · 2 MB can be freed"),
    ).toBeTruthy();
    expect(api.deleteMediaLibrary).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete everything not used by any session…",
      }),
    );
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    // The prompt states how many items and how much space.
    expect(confirm.mock.calls[0]![0]).toContain("Items to delete: 2 (2 MB)");
    expect(api.deleteMediaLibrary).not.toHaveBeenCalled();
  });

  it("offers a batch choice only for media that no session uses", async () => {
    api.listMediaLibrary.mockResolvedValue(page([item("a"), item("b"), USED]));
    render(<MediaLibraryPane />);
    await screen.findByText("Stored items: 3 · 3 MB");

    expect(screen.queryByRole("checkbox", { name: "Select used.png" })).toBe(
      null,
    );
    const deleteSelected = () =>
      screen.getByRole("button", { name: /^Delete selected/ });
    expect(deleteSelected()).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select a.png" }));
    expect(deleteSelected().textContent).toContain("1 · 1 MB");
    fireEvent.click(
      screen.getByRole("button", { name: "Select unused on this page" }),
    );
    expect(deleteSelected().textContent).toContain("2 · 2 MB");

    api.deleteMediaLibrary.mockResolvedValue({
      deletedIds: ["a", "b"],
      bytesDeleted: 2 * MB,
      skipped: [],
    });
    api.listMediaLibrary.mockResolvedValue(page([USED]));
    fireEvent.click(deleteSelected());

    await waitFor(() =>
      expect(api.deleteMediaLibrary).toHaveBeenCalledWith({ ids: ["a", "b"] }),
    );
    expect(confirm.mock.calls[0]![0]).toContain("Items to delete: 2 (2 MB)");
    await screen.findByText("Stored items: 1 · 1 MB");
    expect(deleteSelected()).toHaveProperty("disabled", true);
  });

  it("names the session that loses a picture before deleting one in use", async () => {
    api.listMediaLibrary.mockResolvedValue(page([USED]));
    render(<MediaLibraryPane />);

    const link = await screen.findByRole("link", { name: /Lantern Harbor/ });
    expect(link.getAttribute("href")).toBe("/session?sid=sess-1");
    expect(link.textContent).toContain("Turn 12");

    confirm.mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete used.png" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    const prompt = String(confirm.mock.calls[0]![0]);
    expect(prompt).toContain("Lantern Harbor · Turn 12");
    expect(prompt).toContain("media unavailable");
    expect(api.deleteMediaLibrary).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete used.png" }));
    await waitFor(() =>
      expect(api.deleteMediaLibrary).toHaveBeenCalledWith({ forceId: "used" }),
    );
  });

  it("marks nothing as unused when the scan was incomplete", async () => {
    const unknown = item("a", { usage: "unknown" });
    api.listMediaLibrary.mockResolvedValue({
      ...page([unknown]),
      scan: { complete: false, incompleteSessionId: "sess-1" },
    });
    render(<MediaLibraryPane />);

    expect((await screen.findByRole("status")).textContent).toContain(
      "cannot tell which media is unused",
    );
    expect(screen.queryByRole("checkbox", { name: "Select a.png" })).toBe(null);
    expect(
      screen.getByRole("button", {
        name: "Delete everything not used by any session…",
      }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText("Use could not be determined")).toBeTruthy();
  });

  it("requests one page for the chosen kind and loads no audio or video up front", async () => {
    api.listMediaLibrary.mockResolvedValue(
      page([
        item("song", { kind: "audio", mime: "audio/mpeg" }),
        item("clip", { kind: "video", mime: "video/mp4" }),
        item("pic"),
      ]),
    );
    const { container } = render(<MediaLibraryPane />);
    await screen.findByText("Stored items: 3 · 3 MB");

    expect(api.listMediaLibrary).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, limit: 48, kind: undefined }),
    );
    expect(container.querySelector("audio")?.getAttribute("preload")).toBe(
      "none",
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("loading")).toBe(
      "lazy",
    );

    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    await waitFor(() =>
      expect(api.listMediaLibrary).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "audio", offset: 0 }),
      ),
    );
  });

  it("explains a server that offers no media library", async () => {
    api.listMediaLibrary.mockRejectedValue(
      new ApiError(503, "/api/media/library", '{"error":"x"}'),
    );
    render(<MediaLibraryPane />);

    expect(
      await screen.findByText(/not available on this server/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  });
});
