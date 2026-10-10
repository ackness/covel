// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import type { MediaLibraryItem } from "@/services/api/media.js";
import {
  formatBytes,
  itemDeleteConfirmation,
  selectionBytes,
  togglePageSelection,
  toggleSelection,
  withoutIds,
  type MediaSelection,
} from "../media-library-model.js";

function item(
  id: string,
  usage: MediaLibraryItem["usage"] = "unused",
  size = 1000,
): MediaLibraryItem {
  return {
    id,
    mime: "image/png",
    kind: "image",
    size,
    createdAt: "2026-10-01T10:00:00.000Z",
    usage,
    usedBy: usage === "used" ? ["sess-1"] : [],
    url: `/api/media/${id}?token=t`,
  };
}

describe("media library selection", () => {
  it("never admits media that is used, held or of unknown use", () => {
    let selection: MediaSelection = new Map();
    for (const usage of ["used", "held", "unknown"] as const) {
      selection = toggleSelection(selection, item(usage, usage));
    }
    expect(selection.size).toBe(0);

    const page = [item("a"), item("b", "used"), item("c", "unknown")];
    expect([...togglePageSelection(selection, page).keys()]).toEqual(["a"]);
  });

  it("keeps the choices of other pages when a page is toggled or items are deleted", () => {
    let selection = toggleSelection(new Map(), item("page1", "unused", 500));
    const page2 = [item("x", "unused", 200), item("y", "unused", 300)];

    selection = togglePageSelection(selection, page2);
    expect([...selection.keys()]).toEqual(["page1", "x", "y"]);
    expect(selectionBytes(selection)).toBe(1000);

    // A fully chosen page toggles off, and only that page.
    expect([...togglePageSelection(selection, page2).keys()]).toEqual([
      "page1",
    ]);
    expect([...withoutIds(selection, ["x", "gone"]).keys()]).toEqual([
      "page1",
      "y",
    ]);
  });
});

describe("media library texts", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("formats sizes in binary units", () => {
    expect(formatBytes(0, "en-US")).toBe("0 B");
    expect(formatBytes(1536, "en-US")).toBe("1.5 KB");
    expect(formatBytes(250 * 1024 * 1024, "en-US")).toBe("250 MB");
  });

  it("warns differently for media in use, held and of unknown use", () => {
    const t = i18n.getFixedT("en-US");
    const used = itemDeleteConfirmation(
      t,
      item("a", "used"),
      ["Lantern Harbor · Turn 3", "Emberback · Turn 9"],
      "en-US",
    );
    expect(used.destructive).toBe(true);
    expect(used.message).toContain(
      "• Lantern Harbor · Turn 3\n• Emberback · Turn 9",
    );

    const messages = (["unused", "used", "held", "unknown"] as const).map(
      (usage) =>
        itemDeleteConfirmation(t, item("a", usage), ["S"], "en-US").message,
    );
    expect(new Set(messages).size).toBe(4);
    expect(messages[0]).toContain("No session uses them");
  });
});
