import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginPanel } from "../plugin-panel.js";

const rpc = vi.hoisted(() => ({
  post: vi.fn(async () => ({ status: "ok", deferredJobs: [] })),
}));
vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  postPluginRpc: rpc.post,
}));
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

afterEach(() => {
  cleanup();
  rpc.post.mockClear();
});

it("emits one of the plugin's own events through plugin-rpc", async () => {
  render(
    <PluginPanel
      pluginId="map"
      spec={{
        alwaysRender: true,
        view: {
          component: "Button",
          props: { label: "Go to the docks" },
          on: {
            click: {
              action: "emitEvent",
              params: {
                topic: "map.location-selected",
                data: { locationId: "docks" },
              },
            },
          },
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Go to the docks" }));
  await waitFor(() => expect(rpc.post).toHaveBeenCalledTimes(1));
  // The plugin id is the panel's own; a spec cannot name another plugin.
  expect(rpc.post.mock.calls[0]).toEqual([
    "session",
    {
      kind: "event",
      pluginId: "map",
      topic: "map.location-selected",
      payload: { locationId: "docks" },
    },
  ]);
});

it("does not call the server for an event without a topic", async () => {
  render(
    <PluginPanel
      pluginId="map"
      spec={{
        alwaysRender: true,
        view: {
          component: "Button",
          props: { label: "Broken" },
          on: { click: { action: "emitEvent", params: { data: {} } } },
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Broken" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(rpc.post).not.toHaveBeenCalled();
});
