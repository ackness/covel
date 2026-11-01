import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { CharacterAvatar } from "../character-avatar-renderer.js";
const slot = vi.hoisted(() => vi.fn());
vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlot: slot }));
vi.mock("../session-context.js", () => ({
  useActiveSessionId: () => "session",
}));
vi.mock("@/components/Media.js", () => ({ Media: () => null }));
vi.mock("@/components/MediaPreviewDialog.js", () => ({
  MediaPreviewDialog: () => null,
}));
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("zh-CN");
});
const renderAvatar = (characterId: string, size?: number) =>
  createElement(CharacterAvatar, {
    element: { type: "CharacterAvatar", props: { characterId, size } },
    emit: () => {},
    on: () => ({ emit: () => {}, bound: false, shouldPreventDefault: false }),
  });
describe("CharacterAvatar", () => {
  it("reads the exact keyed visual projection", () => {
    slot.mockReturnValue({
      value: {
        characterId: "scoped-hero",
        avatar: { id: "a".repeat(64), mime: "image/png", size: 1 },
      },
    });
    render(renderAvatar("scoped-hero"));
    expect(slot).toHaveBeenCalledWith(
      "session",
      "character.visual@1",
      "scoped-hero",
    );
    expect(screen.getByRole("button", { name: "放大立绘" })).toBeTruthy();
  });
  it("does not render an avatar for absent imagery", () => {
    slot.mockReturnValue(undefined);
    const { container } = render(renderAvatar("unknown"));
    expect(container.childElementCount).toBe(0);
  });
  it.each([
    ["zh-CN", "放大立绘"],
    ["en-US", "Enlarge portrait"],
    ["ru-RU", "Увеличить портрет"],
  ] as const)("uses the host preview label in %s", async (locale, label) => {
    await i18n.changeLanguage(locale);
    slot.mockReturnValue({
      value: {
        characterId: "scoped-hero",
        avatar: { id: "a".repeat(64), mime: "image/png", size: 1 },
      },
    });
    render(renderAvatar("scoped-hero"));
    expect(screen.getByRole("button", { name: label }).style.width).toBe(
      "28px",
    );
  });
});
