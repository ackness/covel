import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@/i18n/index.js";
import { WORLD_LORE_TOKEN_BUDGET } from "@covel/shared";
import { WorldLoreCard } from "../session-prep/world-lore-card.js";

function card(lore: string) {
  return render(
    <WorldLoreCard
      expanded
      onToggle={vi.fn()}
      loreValue={lore}
      originalLore={lore}
      isModified={false}
      onLoreChange={vi.fn()}
      onResetLore={vi.fn()}
      draftStatus="ready"
      onRetry={vi.fn()}
    />,
  );
}

describe("WorldLoreCard", () => {
  it("warns while the lore is longer than the story prompt carries", () => {
    card("A long line of lore.\n".repeat(WORLD_LORE_TOKEN_BUDGET));
    expect(screen.getByRole("note").textContent).toContain(
      String(WORLD_LORE_TOKEN_BUDGET),
    );
  });

  it("says nothing for lore that fits", () => {
    card("A short world.");
    expect(screen.queryByRole("note")).toBeNull();
  });
});
