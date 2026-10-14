/**
 * EntryCard tests.
 *
 * Covers the generic visual nice-to-have props (`collapsible`, `isNew`)
 * that any plugin panel can use — not codex-specific behaviour.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { JSONUIProvider } from "@json-render/react";
import { covelRegistry } from "../catalog.js";
import i18n from "../../i18n/index.js";

afterEach(cleanup);

function renderEntryCard(props: Record<string, unknown>) {
  const EntryCard = covelRegistry.EntryCard!;
  return render(
    <JSONUIProvider registry={covelRegistry}>
      <EntryCard
        element={{ type: "EntryCard", props }}
        emit={() => {}}
        on={() => ({
          emit: () => {},
          shouldPreventDefault: false,
          bound: false,
        })}
      />
    </JSONUIProvider>,
  );
}

describe("EntryCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  const baseProps = {
    title: "Goblin Scout",
    category: "monster",
    content: "A scrawny goblin armed with a rusty dagger.",
    tags: ["weak", "stealth"],
    rarity: "common",
  };

  it("renders title, content, and tags by default (no collapsible)", () => {
    renderEntryCard(baseProps);
    expect(screen.getByText("Goblin Scout")).toBeDefined();
    expect(
      screen.getByText("A scrawny goblin armed with a rusty dagger."),
    ).toBeDefined();
    expect(screen.getByText("weak")).toBeDefined();
    expect(screen.getByText("stealth")).toBeDefined();
  });

  describe("collapsible", () => {
    it("hides content + tags when collapsible=true and defaultExpanded=false", () => {
      renderEntryCard({
        ...baseProps,
        collapsible: true,
        defaultExpanded: false,
      });
      expect(screen.getByText("Goblin Scout")).toBeDefined();
      expect(
        screen.queryByText("A scrawny goblin armed with a rusty dagger."),
      ).toBeNull();
      expect(screen.queryByText("weak")).toBeNull();
    });

    it("shows content + tags when collapsible=true and defaultExpanded=true", () => {
      renderEntryCard({
        ...baseProps,
        collapsible: true,
        defaultExpanded: true,
      });
      expect(
        screen.getByText("A scrawny goblin armed with a rusty dagger."),
      ).toBeDefined();
      expect(screen.getByText("weak")).toBeDefined();
    });

    it("reveals content when the title row is clicked", () => {
      renderEntryCard({
        ...baseProps,
        collapsible: true,
        defaultExpanded: false,
      });
      expect(
        screen.queryByText("A scrawny goblin armed with a rusty dagger."),
      ).toBeNull();

      const toggle = screen.getByRole("button", { name: /Goblin Scout/ });
      fireEvent.click(toggle);

      expect(
        screen.getByText("A scrawny goblin armed with a rusty dagger."),
      ).toBeDefined();
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });

    it("exposes aria-expanded when collapsible", () => {
      renderEntryCard({
        ...baseProps,
        collapsible: true,
        defaultExpanded: false,
      });
      const toggle = screen.getByRole("button", { name: /Goblin Scout/ });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });

    it("does not render a button role when collapsible is false", () => {
      renderEntryCard(baseProps);
      expect(screen.queryByRole("button", { name: /Goblin Scout/ })).toBeNull();
    });
  });

  describe("isNew", () => {
    it("renders a NEW badge when isNew=true", () => {
      renderEntryCard({ ...baseProps, isNew: true });
      const badge = screen.getByLabelText("new");
      expect(badge).toBeDefined();
      expect(badge.textContent).toContain("NEW");
    });

    it("does not render a NEW badge when isNew is absent", () => {
      renderEntryCard(baseProps);
      expect(screen.queryByLabelText("new")).toBeNull();
    });

    it("does not render a NEW badge when isNew=false", () => {
      renderEntryCard({ ...baseProps, isNew: false });
      expect(screen.queryByLabelText("new")).toBeNull();
    });
  });
});

describe("provider-owned entry presentation", () => {
  it.each(["en-US", "zh-CN"])(
    "resolves category labels for %s and uses declared rarity style",
    async (locale) => {
      await i18n.changeLanguage(locale);
      const { container } = renderEntryCard({
        title: "Dispatch",
        category: "urgent",
        rarity: "priority-1",
        categoryOptions: [
          {
            value: "urgent",
            label: { en: "Urgent", zh: "紧急" },
            icon: "compass",
            color: "blue",
          },
        ],
        rarityOptions: [{ value: "priority-1", tone: "danger", color: "red" }],
      });
      const badge = screen.getByText(locale === "zh-CN" ? "紧急" : "Urgent");
      expect(badge.className).toContain("text-red-600");
      expect(
        container.querySelector(".ui-band")?.getAttribute("data-tone"),
      ).toBe("danger");
      expect(container.querySelector("svg.lucide-compass")).toBeTruthy();
    },
  );
  it.each([
    { category: "monster", rarity: "legendary" },
    { category: "unfamiliar", rarity: "unfamiliar" },
    {
      category: "constructor",
      rarity: "constructor",
      categoryOptions: {},
      rarityOptions: [null],
    },
  ])("uses neutral defaults without inferring gameplay enums: %j", (props) => {
    const { container } = renderEntryCard({ title: "An entry", ...props });
    expect(screen.getByText(props.category)).toBeTruthy();
    expect(container.querySelector(".ui-band")?.getAttribute("data-tone")).toBe(
      "muted",
    );
    expect(container.querySelector("svg.lucide-book-open")).toBeTruthy();
    expect(container.querySelector("svg.lucide-skull")).toBeNull();
  });
  it("keeps explicit per-entry icon/color overrides", () => {
    const { container } = renderEntryCard({
      title: "Override",
      category: "place",
      icon: "gem",
      color: "red",
      categoryOptions: [
        { value: "place", label: "Place", icon: "compass", color: "blue" },
      ],
    });
    expect(
      container.querySelector("svg.lucide-gem")?.getAttribute("class"),
    ).toContain("text-red-500");
  });
});
