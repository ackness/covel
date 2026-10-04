import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { listWorldGallery, type WorldRecord } from "@/services/api.js";
import { WorldShowcase } from "../world-showcase.js";
import { WorldTileCard } from "../world-list-variants.js";
import type { WorldListViewProps } from "../world-list-view.js";

vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  listWorldGallery: vi.fn(),
}));

const world = (id: string, name: string): WorldRecord => ({
  id,
  name,
  description: `${name} summary`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const picture = (id: string, width: number, height: number) => ({
  id,
  source: id.split("/")[0]!,
  url: `/api/worlds/ash-harbor/gallery/${id}?v=1`,
  width,
  height,
});

const GALLERY = [
  picture("scenes/quay.png", 1536, 1024),
  picture("scenes/market.png", 1536, 1024),
  picture("portraits/mara.png", 1024, 1536),
];

function renderShowcase(worlds: WorldRecord[]) {
  const props: WorldListViewProps = {
    worlds,
    t: i18n.t,
    primarySlotLabel: null,
    enabledPluginCount: 0,
    enteringWorldId: null,
    storageLabel: () => "",
    interfaceLocale: "zh-CN",
    onOpenGenerator: () => {},
    onOpenSettings: () => {},
    onEnterWorld: () => {},
    onViewDetails: () => {},
    onDeleteWorld: () => {},
  };
  return render(<WorldShowcase {...props} />);
}

/** The image that fills the screen behind the title. */
const backdrop = (container: HTMLElement) =>
  container.querySelector("img.ui-stage-crossfade")?.getAttribute("src");

/** Let the gallery request settle while the timers are faked. */
const settle = () => act(async () => {});

describe("world showcase", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(listWorldGallery).mockImplementation(async (worldId) =>
      worldId === "ash-harbor" ? GALLERY : [],
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rotates the world's scenes behind the title", async () => {
    const { container } = renderShowcase([world("ash-harbor", "Ash Harbor")]);
    await settle();

    // The two scenes; the portrait never fills the screen.
    expect(
      screen.getAllByRole("button", { name: /^显示第 \d 张背景$/ }),
    ).toHaveLength(2);
    expect(backdrop(container)).toBe(GALLERY[0]!.url);

    act(() => void vi.advanceTimersByTime(7000));
    expect(backdrop(container)).toBe(GALLERY[1]!.url);

    // A slide picked by hand stays: the rotation stops.
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("world.slideShow", { index: 1 }),
      }),
    );
    expect(backdrop(container)).toBe(GALLERY[0]!.url);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(backdrop(container)).toBe(GALLERY[0]!.url);
    expect(
      screen.getByRole("button", { name: i18n.t("world.slidesPlay") }),
    ).toBeTruthy();
  });

  it("opens on the cover of a world that has one", async () => {
    vi.mocked(listWorldGallery).mockResolvedValue(GALLERY);
    const { container } = renderShowcase([world("mistport", "Mistport")]);
    await settle();

    expect(
      screen.getAllByRole("button", { name: /^显示第 \d 张背景$/ }),
    ).toHaveLength(3);
    expect(backdrop(container)).toBe("/visuals/worlds/mistport.webp");
  });

  it("opens the world's pictures at full size, portraits first", async () => {
    renderShowcase([world("ash-harbor", "Ash Harbor")]);
    await settle();

    const strip = screen.getByRole("group", { name: i18n.t("world.gallery") });
    fireEvent.click(within(strip).getAllByRole("button")[0]!);

    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      GALLERY[2]!.url,
    );
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      GALLERY[0]!.url,
    );
  });

  it("shows no gallery for a world without pictures", async () => {
    renderShowcase([world("plain", "Plain")]);
    await settle();

    expect(screen.queryByRole("group", { name: i18n.t("world.gallery") })).toBe(
      null,
    );
    expect(screen.queryByRole("button", { name: /张背景$/ })).toBe(null);
  });

  it("lists every world when the strip of covers cannot show them all", async () => {
    // A strip narrower than its covers.
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(2000);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    const worlds = [
      "Ash Harbor",
      "Brine Hollow",
      "Cinder Vale",
      "Dusk Fen",
    ].map((name) => world(name.toLowerCase().replace(" ", "-"), name));
    renderShowcase(worlds);
    await settle();

    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("session.allWorlds", { total: 4 }),
      }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("searchbox"), {
      target: { value: "cinder" },
    });
    const matches = within(dialog).getAllByRole("button", { pressed: false });
    expect(matches.map((button) => button.textContent)).toEqual([
      "Cinder Vale",
    ]);
    fireEvent.click(matches[0]!);

    expect(screen.queryByRole("dialog")).toBe(null);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Cinder Vale",
    );
  });
});

describe("world card", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(listWorldGallery).mockResolvedValue(GALLERY);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes the world's scenes over the cover under the pointer and opens its gallery", async () => {
    const { container } = render(
      <WorldTileCard
        world={world("mistport", "Mistport")}
        index={0}
        isEntering={false}
        dimmed={false}
        storageLabel=""
        interfaceLocale="zh-CN"
        t={i18n.t}
        onEnter={() => {}}
        onViewDetails={() => {}}
        onDelete={() => {}}
      />,
    );
    await settle();
    const cover = container.querySelector(
      "img.ui-stage-crossfade",
    )!.parentElement!;

    // At rest the card shows its cover, however long it is left alone.
    act(() => void vi.advanceTimersByTime(10_000));
    expect(backdrop(container)).toBe("/visuals/worlds/mistport.webp");

    fireEvent.pointerEnter(cover);
    act(() => void vi.advanceTimersByTime(2600));
    expect(backdrop(container)).toBe(GALLERY[0]!.url);
    fireEvent.pointerLeave(cover);
    expect(backdrop(container)).toBe("/visuals/worlds/mistport.webp");

    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("world.galleryAll", { total: 3 }),
      }),
    );
    expect(
      screen.getByRole("dialog").querySelector("img")?.getAttribute("src"),
    ).toBe(GALLERY[2]!.url);
  });
});
