import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import type { WorldRecord } from "@/services/api.js";
import { HistoryTab } from "../tabs/history-tab.js";
import { WorldCard } from "../world-card.js";
import { WorldEditor } from "../world-editor.js";

afterEach(cleanup);

const world = {
  id: "test-world",
  name: "Test World",
  description: "A world used by the editor accessibility tests.",
  locale: "en-US",
  tags: ["test"],
  dimensions: {
    history: [
      {
        era: "First Age",
        year: "10",
        name: "Arrival",
        description: "The first travelers arrived.",
        significance: "major",
      },
    ],
  },
} as WorldRecord;

describe("WorldCard", () => {
  it("uses an independent button for entering the world", () => {
    const onEnter = vi.fn();
    const onViewDetails = vi.fn();

    render(
      <WorldCard
        world={world}
        index={0}
        isEntering={false}
        dimmed={false}
        storageLabel="Built-in"
        t={i18n.t}
        onEnter={onEnter}
        onViewDetails={onViewDetails}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("heading", { name: "Test World" }));
    expect(onEnter).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("world.viewDetails") }),
    );
    expect(onViewDetails).toHaveBeenCalledOnce();
    expect(onEnter).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("session.enter") }),
    );
    expect(onEnter).toHaveBeenCalledWith(world.id);
  });
});

describe("WorldEditor", () => {
  it("gives every icon tab an accessible localized name", () => {
    render(<WorldEditor world={world} onSave={vi.fn()} onCancel={vi.fn()} />);

    for (const labelKey of [
      "world.geography",
      "world.factions",
      "world.powerSystem",
      "world.history",
      "world.economy",
      "world.socialStructure",
      "world.tone",
      "world.mechanics",
      "world.startingConditions",
    ]) {
      const label = i18n.t(labelKey);
      expect(
        screen.getByRole("tab", { name: label }).getAttribute("aria-label"),
      ).toBe(label);
    }
  });

  it("associates history labels and keeps the event grid responsive", () => {
    render(
      <HistoryTab
        dimensions={world.dimensions ?? {}}
        onChange={vi.fn()}
        t={i18n.t}
      />,
    );

    expect(screen.getByLabelText(i18n.t("world.era"))).toBeTruthy();
    expect(screen.getByLabelText(i18n.t("world.year"))).toBeTruthy();
    expect(screen.getByLabelText(i18n.t("world.name"))).toBeTruthy();
    expect(screen.getByLabelText(i18n.t("world.significance"))).toBeTruthy();
    expect(screen.getByLabelText(i18n.t("world.description"))).toBeTruthy();
    expect(
      screen.getByLabelText(i18n.t("world.remove"), { selector: "button" }),
    ).toBeTruthy();

    const historyGrid = screen
      .getByLabelText(i18n.t("world.era"))
      .closest(".grid");
    expect(historyGrid?.className).toContain("grid-cols-1");
    expect(historyGrid?.className).toContain("xl:grid-cols-4");
  });
});
