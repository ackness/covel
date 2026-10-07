import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { nestedToFlat } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import i18n from "@/i18n";
import { covelRegistry } from "../../catalog.js";
import { PluginPanel } from "@/components/session/plugin-panel.js";

vi.mock("react-force-graph-2d", () => ({ default: () => null }));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: { gameState: { characters: [] }, pendingInteractionDrafts: [] },
  }),
}));
afterEach(cleanup);

function renderControls(type: string, valueProp = "value") {
  const changed = vi.fn();
  const spec = nestedToFlat({
    type: "Stack",
    children: ["first", "second"].map((key) => ({
      type,
      props: {
        label: { "en-US": "Control", "ru-RU": "Поле" },
        [valueProp]: { $bindState: `/${key}` },
        options: [
          {
            value: "initial",
            label: { "en-US": "Initial", "ru-RU": "Исходное" },
          },
          { value: "edited", label: "Edited" },
        ],
      },
    })),
  });
  const view = render(
    <JSONUIProvider
      registry={covelRegistry}
      initialState={{
        first: valueProp === "checked" ? false : "initial",
        second: valueProp === "checked" ? false : "initial",
      }}
      handlers={{}}
      onStateChange={changed}
    >
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>,
  );
  return { ...view, changed };
}

describe("catalog interactive accessibility through the real registry and state provider", () => {
  it("names native switch buttons, preserves independent checked bindings, and does not submit forms", async () => {
    await i18n.changeLanguage("en-US");
    const { changed } = renderControls("Switch", "checked");
    const [first, second] = screen.getAllByRole("switch", { name: "Control" });
    expect(first.tagName).toBe("BUTTON");
    expect(first.getAttribute("type")).toBe("button");
    expect(first.getAttribute("aria-checked")).toBe("false");
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.click(first);
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(second.getAttribute("aria-checked")).toBe("false");
    expect(changed).toHaveBeenLastCalledWith([{ path: "/first", value: true }]);
    fireEvent.click(screen.getAllByText("Control")[1]);
    expect(second.getAttribute("aria-checked")).toBe("true");
    expect(changed).toHaveBeenLastCalledWith([
      { path: "/second", value: true },
    ]);
  });

  it.each(["Input", "Textarea", "Select"])(
    "associates duplicate %s labels with stable unique IDs and preserves localized bindings",
    async (type) => {
      await i18n.changeLanguage("en-US");
      const { container, changed } = renderControls(type);
      const [first, second] = screen.getAllByLabelText("Control") as Array<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >;
      expect(first.id).not.toBe("");
      expect(first.id).not.toBe(second.id);
      const ids = [first.id, second.id];
      const labels = [...container.querySelectorAll("label")];
      expect(labels.map((label) => label.control)).toEqual([first, second]);
      expect(labels.map((label) => label.htmlFor)).toEqual(ids);
      fireEvent.change(first, { target: { value: "edited" } });
      expect(first.value).toBe("edited");
      expect(second.value).toBe("initial");
      expect(changed).toHaveBeenLastCalledWith([
        { path: "/first", value: "edited" },
      ]);
      await act(async () => {
        await i18n.changeLanguage("ru-RU");
      });
      expect(
        screen.getAllByLabelText("Поле").map((control) => control.id),
      ).toEqual(ids);
      if (type === "Select")
        expect(
          screen.getAllByRole("option", { name: "Исходное" }),
        ).toHaveLength(2);
      // jsdom resolves label.control but does not implement browser label-focus
      // or native keyboard activation/inert. Those require the browser probe.
    },
  );

  it("retains the existing panel inert boundary for every newly labelable control", () => {
    const spec = {
      alwaysRender: true,
      view: {
        component: "Stack",
        children: ["Input", "Textarea", "Select", "Switch"].map(
          (component) => ({
            component,
            props: {
              label: component,
              value: { $bindState: "/text" },
              checked: { $bindState: "/checked" },
              options: [{ value: "initial", label: "Initial" }],
            },
          }),
        ),
      },
    };
    const props = {
      pluginId: "synthetic-owner",
      spec,
      stateOverride: { text: "initial", checked: false },
    };
    const { rerender } = render(<PluginPanel {...props} interactionLocked />);
    const controls = [
      screen.getByRole("textbox", { name: "Input" }),
      screen.getByRole("textbox", { name: "Textarea" }),
      screen.getByRole("combobox", { name: "Select" }),
      screen.getByRole("switch", { name: "Switch" }),
    ];
    for (const control of controls) {
      expect(control.closest("[inert]")?.getAttribute("aria-disabled")).toBe(
        "true",
      );
    }
    rerender(<PluginPanel {...props} />);
    for (const control of controls)
      expect(control.closest("[inert]")).toBeNull();
  });
});
