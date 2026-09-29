import type { ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JSONUIProvider } from "@json-render/react";
import { PluginPanel } from "../plugin-panel.js";

const captured = vi.hoisted(() => ({
  handlers: undefined as ComponentProps<typeof JSONUIProvider>["handlers"],
}));
vi.mock("@json-render/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@json-render/react")>();
  return {
    ...actual,
    JSONUIProvider: (props: ComponentProps<typeof actual.JSONUIProvider>) => {
      captured.handlers = props.handlers;
      return <actual.JSONUIProvider {...props} />;
    },
  };
});
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      gameState: { characters: [] },
      session: { id: "session" },
      pendingInteractionDrafts: [],
    },
  }),
}));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));

afterEach(cleanup);

it("blocks locked actions, including callbacks retained before locking, and resumes on unlock", async () => {
  const action = vi.fn();
  const spec = {
    alwaysRender: true,
    view: {
      component: "Button",
      props: { label: "Run action" },
      on: { click: { action: "testAction", params: { value: "clicked" } } },
    },
  };
  const props = { pluginId: "test", spec, handlers: { testAction: action } };
  const { rerender } = render(<PluginPanel {...props} />);
  const retainedHandler = captured.handlers!.testAction!;
  const button = screen.getByRole("button", { name: "Run action" });
  fireEvent.click(button);
  await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  rerender(<PluginPanel {...props} interactionLocked />);
  expect(button.closest("[inert]")).not.toBeNull();

  // jsdom does not implement inert's native input suppression. Dispatching
  // directly verifies the handler guard as well as the DOM lock above.
  await act(async () => {
    fireEvent.click(button);
    await retainedHandler({ value: "retained" });
  });
  expect(action).toHaveBeenCalledTimes(1);

  rerender(<PluginPanel {...props} />);
  expect(button.closest("[inert]")).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
});
