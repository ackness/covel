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
  upsertInteractionDraft: vi.fn(),
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: { sessionPlugins: mocks.plugins, gameState: {} },
  }),
  useSessionActions: () => ({
    upsertInteractionDraft: mocks.upsertInteractionDraft,
  }),
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
  PluginPanel: ({
    pluginId,
    expanded,
    handlers,
  }: {
    pluginId: string;
    expanded?: boolean;
    handlers?: Record<string, (params: Record<string, unknown>) => unknown>;
  }) => {
    const [owner] = useState(pluginId);
    return (
      <div>
        Mounted panel: {owner}
        {expanded ? " (large)" : ""}
        <button
          type="button"
          onClick={() =>
            handlers?.draftMessage?.({
              text: " Go to the docks ",
              selectionGroup: "map",
            })
          }
        >
          Draft a move
        </button>
      </div>
    );
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
  serverCodeApproved: true,
  sessionState: "active",
  requires: [],
  optional: [],
  conflicts: [],
  extensions: [],
  eventTopics: [],
  id,
  displayName: id,
  description: id,
  active: true,
  locked: false,
  hostState: "loaded",
  kind: "plugin",
  source: "builtin",
  runtimeCount: 0,
  runtimes: [],
  tools: [],
  userSettings: [],
  languages: { text: ["en"], instructions: ["en"] },
  provides: [],
  tags: [],
});
beforeEach(async () => {
  mocks.upsertInteractionDraft.mockReset();
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
    // The mocked store is not reactive and the panel is memoised, so a new
    // patches array stands in for the store update that re-renders it.
    view.rerender(<RightPanel {...props} statePatches={[]} />);
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
    view.rerender(<RightPanel {...props} statePatches={[]} />);
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

it("lets a side panel queue a line for the composer without sending it", async () => {
  render(<RightPanel sessionId="session-a" world={null} statePatches={[]} />);
  fireEvent.keyDown(await screen.findByRole("tab", { name: "Shared panels" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("button", { name: "Draft a move" }));
  expect(mocks.upsertInteractionDraft).toHaveBeenCalledWith({
    id: "panel:map",
    turnId: "panel",
    interactionId: "map",
    type: "suggestion",
    label: "Go to the docks",
    values: { text: "Go to the docks" },
    selectionGroup: "map",
  });
});

it("moves a plugin panel into the large dialog and back", async () => {
  render(<RightPanel sessionId="session-a" world={null} statePatches={[]} />);
  fireEvent.keyDown(await screen.findByRole("tab", { name: "Shared panels" }), {
    key: "Enter",
  });
  expect(await screen.findByText(/Mounted panel: provider-a$/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
  // One instance at a time: the dialog has the panel, the column a note.
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Mounted panel: provider-a (large)");
  expect(screen.getAllByText(/Mounted panel: provider-a/)).toHaveLength(1);
  expect(
    screen.getByText("This panel is open in the large view."),
  ).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText(/Mounted panel: provider-a$/)).toBeTruthy();
});
