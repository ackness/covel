import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
describe("CharacterAvatar", () => {
  it("reads the exact keyed visual projection", () => {
    slot.mockReturnValue({
      value: {
        characterId: "scoped-hero",
        avatar: { id: "a", mime: "image/png", size: 1 },
      },
    });
    render(
      createElement(CharacterAvatar, {
        element: {
          type: "CharacterAvatar",
          props: { characterId: "scoped-hero" },
        },
      } as never),
    );
    expect(slot).toHaveBeenCalledWith(
      "session",
      "character.visual@1",
      "scoped-hero",
    );
    expect(
      screen.getByRole("button", { name: "enlarge portrait" }),
    ).toBeTruthy();
  });
  it("does not render an avatar for absent imagery", () => {
    slot.mockReturnValue(undefined);
    const { container } = render(
      createElement(CharacterAvatar, {
        element: { type: "CharacterAvatar", props: { characterId: "unknown" } },
      } as never),
    );
    expect(container.childElementCount).toBe(0);
  });
});
