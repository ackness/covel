import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginPanel } from "../plugin-panel.js";
import { postPluginRpc } from "@/services/api/plugin-rpc.js";

const rpc = vi.hoisted(() => ({
  post: vi.fn<typeof import("@/services/api/plugin-rpc.js").postPluginRpc>(
    async () => ({ status: "ok", deferredJobs: [] }),
  ),
  toast: vi.fn(),
}));
vi.mock("@/lib/toast-channel.js", () => ({ emitToast: rpc.toast }));
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
  useSessionStructure: () => ({
    gameState: { characters: [] },
    session: { id: "session" },
    world: null,
    sessionPlugins: [],
  }),
}));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  rpc.post.mockClear();
  rpc.toast.mockReset();
  vi.unstubAllGlobals();
});

it.each(
  ["invokeRuntime", "invokePluginAction", "invokeCommand", "emitEvent"].flatMap(
    (action) =>
      ([500, 503, "network"] as const).map((failure) => ({ action, failure })),
  ),
)(
  "shows one error for $action failure $failure",
  async ({ action, failure }) => {
    const fetchMock = vi.fn();
    if (failure === "network")
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    else
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "Request refused" }), {
          status: failure,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    rpc.post.mockImplementationOnce(postPluginRpc);
    render(
      <PluginPanel
        pluginId="map"
        spec={{
          alwaysRender: true,
          view: {
            component: "Button",
            props: { label: "Try operation" },
            on: {
              click: {
                action,
                params: {
                  runtimeId: "map/update",
                  action: "update",
                  command: "update",
                  topic: "map.updated",
                },
              },
            },
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try operation" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(rpc.toast).toHaveBeenCalled());
    expect(rpc.toast).toHaveBeenCalledTimes(1);
  },
);

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
