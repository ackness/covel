import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TranslateWorldEvent, WorldRecord } from "@/services/api.js";

const api = vi.hoisted(() => ({ translateWorld: vi.fn() }));
vi.mock("@/services/api.js", () => api);

const { WorldTranslatePanel, isWorldTranslatable } =
  await import("../world-translate-panel.js");

const world = {
  id: "ash-harbor",
  name: "灰港",
  description: "每个冬天都会燃烧的港口。",
  locale: "zh-CN",
  metadata: { storage: { scope: "server", backend: "file" } },
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
} as WorldRecord;

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorldTranslatePanel", () => {
  it("is offered for a file world that has no edition in the interface language", () => {
    expect(isWorldTranslatable(world, "en-US")).toBe(true);
    // The world's own language, and an edition it already has.
    expect(isWorldTranslatable(world, "zh-CN")).toBe(false);
    expect(
      isWorldTranslatable(
        {
          ...world,
          metadata: {
            ...world.metadata,
            supportedLocales: ["zh-CN", "en-US"],
          },
        } as WorldRecord,
        "en-GB",
      ),
    ).toBe(false);
    // A world in a store or a browser has no files to write beside.
    expect(
      isWorldTranslatable(
        {
          ...world,
          metadata: { storage: { scope: "browser", backend: "indexeddb" } },
        } as WorldRecord,
        "en-US",
      ),
    ).toBe(false);
  });

  it("asks before it spends model calls, then hands back the translated world", () => {
    let onEvent: ((event: TranslateWorldEvent) => void) | undefined;
    api.translateWorld.mockImplementation(
      (
        _id: string,
        _locale: string,
        next: (e: TranslateWorldEvent) => void,
      ) => {
        onEvent = next;
        return new AbortController();
      },
    );
    const onTranslated = vi.fn();
    render(
      <WorldTranslatePanel
        world={world}
        locale="en-US"
        onTranslated={onTranslated}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Translate to English" }),
    );
    // One click does not start it.
    expect(api.translateWorld).not.toHaveBeenCalled();
    expect(screen.getByText(/uses model calls/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Start the translation" }),
    );
    expect(api.translateWorld).toHaveBeenCalledWith(
      "ash-harbor",
      "en-US",
      expect.any(Function),
      expect.any(Function),
    );

    act(() =>
      onEvent!({ type: "progress", step: "texts", done: 12, total: 40 }),
    );
    expect(screen.getByRole("status").textContent).toContain("12 / 40");

    const translated = {
      ...world,
      metadata: { ...world.metadata, supportedLocales: ["zh-CN", "en-US"] },
    } as WorldRecord;
    act(() =>
      onEvent!({
        type: "done",
        world: translated,
        total: 40,
        translated: 40,
        failed: 0,
      }),
    );
    expect(onTranslated).toHaveBeenCalledWith(translated);
  });

  it("can be called off before it starts", () => {
    render(
      <WorldTranslatePanel
        world={world}
        locale="en-US"
        onTranslated={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Translate to English" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.translateWorld).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Translate to English" }),
    ).toBeTruthy();
  });
});
