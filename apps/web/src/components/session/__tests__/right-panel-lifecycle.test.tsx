import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionPlugin, UISpecsResponse } from "@/services/api.js";
import i18n from "@/i18n";
import { RightPanel } from "../right-panel.js";

const mocks = vi.hoisted(() => ({
  plugins: [] as SessionPlugin[],
  specs: { right: [], message: [], left: [] } as UISpecsResponse,
  fetchSpecs: vi.fn(),
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { sessionPlugins: mocks.plugins } }),
}));
vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  fetchServerHealth: async () => ({}),
  fetchUiSpecs: mocks.fetchSpecs,
  listPluginData: async () => [],
}));
vi.mock("../world-document-panel.js", () => ({
  WorldDocumentPanel: () => <div>World content</div>,
}));
vi.mock("../database-panel.js", () => ({
  DatabasePanel: () => <div>Database content</div>,
}));
vi.mock("../plugin-panel.js", () => ({
  PluginPanel: ({ pluginId }: { pluginId: string }) => {
    const [owner] = useState(pluginId);
    return <div>Mounted panel: {owner}</div>;
  },
}));
const spec = (pluginId: string, panelId: string) => ({
  pluginId,
  specs: [
    {
      id: panelId,
      group: "shared",
      groupLabel: "Shared panels",
      label: panelId,
      icon: "book-open",
      view: { component: "Text" },
    },
  ],
});
const plugin = (id: string): SessionPlugin => ({
  id,
  displayName: id,
  description: id,
  active: true,
  locked: false,
  status: "registered",
  pluginType: "plugin",
  source: "builtin",
  runtimeCount: 0,
  runtimes: [],
  tools: [],
  userSettings: [],
  capabilities: [],
  tags: [],
});
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  mocks.plugins = [plugin("provider-a"), plugin("provider-b")];
  mocks.specs = {
    right: [spec("provider-a", "details"), spec("provider-b", "details")],
    message: [],
    left: [],
  };
  mocks.fetchSpecs.mockReset().mockImplementation(async () => mocks.specs);
});
it("keeps shared panel selection stable across provider changes and resets across sessions", async () => {
  const props = { sessionId: "session-a", world: null, statePatches: [] };
  const view = render(<RightPanel {...props} />);
  fireEvent.keyDown(await screen.findByRole("tab", { name: "Shared panels" }), {
    key: "Enter",
  });
  expect(await screen.findByText("Mounted panel: provider-a")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "provider-b" }));
  expect(await screen.findByText("Mounted panel: provider-b")).toBeTruthy();
  await act(async () => {
    mocks.plugins = [plugin("provider-b")];
    mocks.specs = { ...mocks.specs, right: [spec("provider-b", "details")] };
    view.rerender(<RightPanel {...props} />);
  });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "provider-a" })).toBeNull(),
  );
  expect(screen.getByText("Mounted panel: provider-b")).toBeTruthy();
  view.rerender(<RightPanel {...props} sessionId="session-b" />);
  expect(await screen.findByText("World content")).toBeTruthy();
});
it("returns to World when the active plugin panel disappears", async () => {
  const props = { sessionId: "session-a", world: null, statePatches: [] };
  const view = render(<RightPanel {...props} />);
  fireEvent.keyDown(await screen.findByRole("tab", { name: "Shared panels" }), {
    key: "Enter",
  });
  await act(async () => {
    mocks.plugins = [];
    mocks.specs = { ...mocks.specs, right: [] };
    view.rerender(<RightPanel {...props} />);
  });
  expect(await screen.findByText("World content")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Shared panels" })).toBeNull();
});

it("retains an image navigation request until lazy specs load and supports repeated requests", async () => {
  let release!: (value: UISpecsResponse) => void;
  mocks.fetchSpecs.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const props = { sessionId: "session-a", world: null, statePatches: [] };
  const view = render(
    <RightPanel {...props} panelRequest={{ event: "open-images" }} />,
  );
  expect(screen.getByText("World content")).toBeTruthy();
  const gallery = spec("provider-a", "portraits");
  gallery.specs[0]!.icon = "image";
  await act(async () => release({ ...mocks.specs, right: [gallery] }));
  expect(await screen.findByText("Mounted panel: provider-a")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("tab", { name: "World" }), {
    key: "Enter",
  });
  expect(screen.getByText("World content")).toBeTruthy();
  view.rerender(
    <RightPanel {...props} panelRequest={{ event: "open-images" }} />,
  );
  expect(await screen.findByText("Mounted panel: provider-a")).toBeTruthy();
});
