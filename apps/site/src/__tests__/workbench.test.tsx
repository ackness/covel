import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { PluginWorkbench } from "../components/PluginWorkbench.js";
import { COPY } from "../copy.js";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const mount = () => render(<PluginWorkbench copy={COPY.en} />);
describe("website plugin examples", () => {
  it("supports wrapping arrow navigation, Home/End and resets", () => {
    mount();
    const first = screen.getByRole("tab", { name: "Dice" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Codex" })).toBe(
      document.activeElement,
    );
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(first).toBe(document.activeElement);
    fireEvent.keyDown(first, { key: "End" });
    expect(screen.getByRole("tab", { name: "Codex" })).toBe(
      document.activeElement,
    );
    expect(screen.getByRole("tabpanel").id).toBe(
      screen.getByRole("tab", { name: "Codex" }).getAttribute("aria-controls"),
    );
  });
  it("uses the actual die plus four and includes both outcomes", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((values) => {
      (values as Uint32Array)[0] = 11;
      return values;
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Roll the dice" }));
    expect(screen.getByRole("status").textContent).toContain("Success");
    expect(screen.getByRole("status").textContent).toContain("12 + 4 = 16");
    vi.mocked(crypto.getRandomValues).mockImplementation((values) => {
      (values as Uint32Array)[0] = 10;
      return values;
    });
    fireEvent.click(screen.getByRole("button", { name: "Roll again" }));
    expect(screen.getByRole("status").textContent).toContain("Failure");
    fireEvent.click(screen.getByRole("button", { name: "Reset example" }));
    expect(screen.getByRole("button", { name: "Roll the dice" })).toBeTruthy();
  });
  it("advances objectives, completes and clears progress on returning", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Quests" }));
    for (let i = 0; i < 3; i++)
      fireEvent.click(
        screen.getByRole("button", { name: "Complete next objective" }),
      );
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("3");
    expect(
      screen
        .getByRole("button", { name: "Completed" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Dice" }));
    fireEvent.click(screen.getByRole("tab", { name: "Quests" }));
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("0");
  });
  it("selects relationships and filters codex without shared state", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Relationships" }));
    fireEvent.click(screen.getByRole("button", { name: /Brannoc Hale/ }));
    expect(screen.getByRole("meter").getAttribute("value")).toBe("5");
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "lore" },
    });
    expect(screen.getByRole("status").textContent).toContain("1");
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "unfindable" },
    });
    expect(screen.getByRole("status").textContent).toContain("0");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("status").textContent).toContain("3");
  });
  it("selects graph nodes, highlights their edges, and keeps affinity separate", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Relationships" }));
    const graph = screen.getByRole("group", {
      name: "Character relationship graph",
    });
    const mirelle = within(graph).getByRole("button", { name: /Mirelle Voss/ });
    expect(within(graph).getAllByRole("button")).toHaveLength(4);
    fireEvent.click(mirelle);
    expect(mirelle.getAttribute("aria-pressed")).toBe("true");
    expect(graph.querySelectorAll('line[data-active="true"]')).toHaveLength(2);
    const profile = screen.getByRole("region", { name: "Character profile" });
    expect(profile.id).toBe(mirelle.getAttribute("aria-controls"));
    expect(
      within(profile).getByRole("heading", { name: "Mirelle Voss" }),
    ).toBeTruthy();
    expect(within(profile).getByText("Hopes to bring home")).toBeTruthy();
    expect(within(profile).getByText("Hosts at the tavern")).toBeTruthy();
    expect(
      screen.getByRole("meter", { name: "Affinity" }).getAttribute("value"),
    ).toBe("3");
    fireEvent.click(
      within(graph).getByRole("button", { name: /Lampkeeper Ysolde/ }),
    );
    expect(screen.queryByRole("meter")).toBeNull();
    expect(
      screen.getByText(COPY.en.workbench.relationships.unknownAffinity),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset example" }));
    expect(
      screen
        .getByRole("button", { name: /Sister Wren/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("meter").getAttribute("value")).toBe("10");
  });
  it("localizes graph nodes, relationship types and character profiles", () => {
    render(<PluginWorkbench copy={COPY.zh} />);
    fireEvent.click(screen.getByRole("tab", { name: "关系" }));
    const graph = screen.getByRole("group", { name: "人物关系图谱" });
    fireEvent.click(within(graph).getByRole("button", { name: /梅瑞尔·沃斯/ }));
    expect(
      screen.getByRole("region", { name: "人物档案" }).textContent,
    ).toContain("接待酒馆客人");
    expect(screen.getByText("与你的关系")).toBeTruthy();
    expect(
      screen.getByRole("meter", { name: "好感度" }).getAttribute("value"),
    ).toBe("3");
  });
  it("renders the Chinese edition", () => {
    render(<PluginWorkbench copy={COPY.zh} />);
    expect(screen.getByRole("button", { name: "掷一次骰" })).toBeTruthy();
    expect(screen.getByText("可交互示例")).toBeTruthy();
  });
});
