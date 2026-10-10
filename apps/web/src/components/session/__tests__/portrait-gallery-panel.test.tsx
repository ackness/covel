import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PortraitGalleryPanel } from "../portrait-gallery-panel.js";

vi.mock("@/lib/catalog/session-context.js", () => ({
  useActiveSessionId: () => "session-a",
}));
vi.mock("@/stores/ui-slot-store.js", () => ({
  useUiSlots: () => [
    {
      slot: "character.visual@1",
      key: "hero",
      value: { characterId: "hero", displayName: "Hero" },
    },
  ],
}));
vi.mock("@/components/Media.js", () => ({ Media: () => null }));
vi.mock("@/components/MediaPreviewDialog.js", () => ({
  MediaPreviewDialog: () => null,
}));

it("shows the projected portraits and offers no way to replace one", () => {
  const { container } = render(<PortraitGalleryPanel />);
  expect(screen.getByText("Hero")).toBeTruthy();
  expect(container.querySelector("input[type=file]")).toBeNull();
});
