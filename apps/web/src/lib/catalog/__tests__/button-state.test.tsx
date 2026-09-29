import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JSONUIProvider, Renderer, createStateStore } from "@json-render/react";
import type { Spec } from "@json-render/core";
import { Button } from "../interactive-renderers.js";

const { pendingDrafts } = vi.hoisted(() => ({
  pendingDrafts: [{ values: { selectedId: "selected" } }],
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { pendingInteractionDrafts: pendingDrafts } }),
}));

afterEach(cleanup);

it("updates selection when a dynamic action param changes in the real store", () => {
  const store = createStateStore({ choiceId: "other" });
  const registry = { Button };
  const spec: Spec = {
    root: "button",
    elements: {
      button: {
        type: "Button",
        props: { label: "Choose" },
        on: {
          click: {
            action: "selectChoice",
            params: { choiceId: { $state: "/choiceId" } },
          },
        },
      },
    },
  };
  render(
    <JSONUIProvider registry={registry} store={store}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>,
  );
  const button = screen.getByRole("button", { name: "Choose" });
  expect(button.getAttribute("aria-pressed")).toBeNull();
  act(() => store.set("/choiceId", "selected"));
  expect(button.getAttribute("aria-pressed")).toBe("true");
  act(() => store.set("/choiceId", "other"));
  expect(button.getAttribute("aria-pressed")).toBeNull();
});

it.each([
  ["invokeRuntime", "runtimeId", "runtime"],
  ["invokePluginAction", "action", "action"],
  ["invokeCommand", "command", "command"],
])("updates pending feedback for dynamic %s params", (action, param, kind) => {
  const store = createStateStore({
    target: "idle",
    _invoking: { [`${kind}:busy`]: true },
  });
  const registry = { Button };
  const spec: Spec = {
    root: "button",
    elements: {
      button: {
        type: "Button",
        props: { label: "Run" },
        on: {
          click: [
            { action: "selectChoice", params: { choiceId: "selected" } },
            { action, params: { [param]: { $state: "/target" } } },
          ],
        },
      },
    },
  };
  render(
    <JSONUIProvider registry={registry} store={store}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>,
  );
  const button = screen.getByRole<HTMLButtonElement>("button", { name: "Run" });
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  act(() => store.set("/target", "busy"));
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  act(() => store.set("/target", "idle"));
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-busy")).toBeNull();
});
