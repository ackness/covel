import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryHistory,
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import i18n from "@/i18n/index.js";
import type { WorldRecord } from "@/services/api.js";
import { emitWorldListRequest } from "@/lib/nav-events.js";
import { createMemoryStore } from "@covel/store/memory";
import type { WorldRecord as StoreWorldRecord } from "@covel/store/browser-sync";
import { BrowserVault } from "@/services/storage/browser-vault.js";
import { LocalDataService } from "@/services/data-service/local.js";
import { fakeSessionServer } from "@/services/__tests__/support/fake-session-server.js";
import { invalidateAllWorldRecords } from "@/services/world-records.js";
import { WorldEditor, WorldEditorLoader } from "../world-editor.js";

const mocks = vi.hoisted(() => ({
  updateWorld: vi.fn(),
  getWorld: vi.fn(),
  requestConfirm: vi.fn(),
}));
const api = vi.hoisted(() => ({
  getWorld: vi.fn(),
  updateWorld: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  uploadBrowserCheckpoint: vi.fn(),
  fetchBrowserCommit: vi.fn(),
}));
vi.mock("@/services/data-service.js", () => ({ getDataService: () => mocks }));
vi.mock("@/services/api.js", () => api);
vi.mock("@/lib/confirm-channel.js", () => ({
  requestConfirm: mocks.requestConfirm,
}));

const world: WorldRecord = {
  id: "draft-world",
  metadata: {
    plugins: ["pack:example", "plugin:missing"],
    pluginPitch: { label: "Watch" },
  },
  name: "Draft world",
  description: "An editor test",
  createdAt: "2026-10-14",
  dimensions: {
    startingConditions: {
      name: "Starting conditions",
      schema: {},
      initialValue: {
        openingScenario: "At the gate",
        startingResources: { Coin: 2 },
      },
    },
  },
};

const disposeHistories: Array<() => void> = [];

function openEditor(browser = false, editorWorld = world, loadRecord = false) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const onExit = vi.fn();
  const root = createRootRoute();
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/editor" }),
    createRoute({ getParentRoute: () => root, path: "/elsewhere" }),
  ]);
  const history = browser
    ? createBrowserHistory()
    : createMemoryHistory({ initialEntries: ["/editor"] });
  if (browser) {
    history.replace("/elsewhere");
    history.flush();
    history.push("/editor");
    history.flush();
  }
  disposeHistories.push(() => history.destroy());
  const router = createRouter({ routeTree, history });
  const Editor = loadRecord ? WorldEditorLoader : WorldEditor;
  const view = render(
    <RouterContextProvider router={router}>
      <Editor
        world={editorWorld}
        onSave={onSave}
        onCancel={onCancel}
        onExit={onExit}
      />
    </RouterContextProvider>,
  );
  return { ...view, onSave, onCancel, onExit, history };
}
function selectStartingConditions() {
  fireEvent.mouseDown(
    screen.getByRole("tab", { name: i18n.t("world.startingConditions") }),
    { button: 0, ctrlKey: false },
  );
}
function changeOpening(value: string) {
  selectStartingConditions();
  fireEvent.change(screen.getByLabelText(i18n.t("world.openingScenario")), {
    target: { value },
  });
}
function cancel() {
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("common.cancel") }),
  );
}
function unload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en-US");
  mocks.requestConfirm.mockResolvedValue(false);
  mocks.updateWorld.mockResolvedValue(world);
});
afterEach(() => {
  cleanup();
  invalidateAllWorldRecords();
  for (const dispose of disposeHistories.splice(0)) dispose();
});

describe("WorldEditor unsaved changes", () => {
  it.each([false, true])(
    "round-trips applied JSON through editor save, browser reload and canonical hydration (clear=%s)",
    async (clear) => {
      const alarm = {
        name: "Harbor alarm",
        schema: { type: "integer" as const, minimum: 0 },
        initialValue: 17,
      };
      const dimensions = clear ? {} : { alarm: { ...alarm, initialValue: 23 } };
      const dbName = `editor-roundtrip-${crypto.randomUUID()}`;
      let vault = new BrowserVault({ dbName });
      const mirror = createMemoryStore();
      let releaseSave: (() => void) | undefined;
      try {
        let service = new LocalDataService(vault);
        // Match portable generation: the authored definitions start in metadata.
        const original: StoreWorldRecord = {
          id: world.id,
          name: "Harbor watch",
          description: "Keep the lamp lit.",
          createdAt: world.createdAt,
          metadata: { ...world.metadata, dimensions: { alarm } },
        };
        await vault.upsertWorld(original);
        await mirror.upsertWorld(original);
        mocks.getWorld.mockImplementation((id: string) => service.getWorld(id));
        mocks.updateWorld.mockImplementation((id: string, patch) =>
          service.updateWorld(id, patch),
        );
        const server = fakeSessionServer({
          vault: () => vault,
          // A server response must not replace the browser's edited document.
          patch: () => ({ world: original }),
        });
        api.getWorld.mockImplementation((id: string) => mirror.getWorld(id));
        api.updateWorld.mockImplementation(
          async (id: string, patch: Partial<StoreWorldRecord>) => {
            await mirror.upsertWorld({ ...original, ...patch, id });
            return mirror.getWorld(id);
          },
        );
        api.createSession.mockImplementation(server.createSession);
        api.deleteSession.mockImplementation(server.deleteSession);
        api.fetchBrowserCommit.mockImplementation(server.fetchBrowserCommit);
        api.getSession.mockResolvedValue({ id: "edited-session" });
        api.uploadBrowserCheckpoint.mockImplementation(
          async (_id, checkpoint) => {
            await mirror.upsertWorld(checkpoint.world);
            return { ok: true, revision: checkpoint.revision };
          },
        );
        const { onSave, unmount } = openEditor(false, world, true);
        const input = await screen.findByLabelText(
          i18n.t("world.dimensionDefinitions"),
          {
            selector: "textarea",
          },
        );
        fireEvent.change(input, {
          target: { value: JSON.stringify(dimensions) },
        });
        fireEvent.click(
          screen.getByRole("button", { name: i18n.t("world.applyDimensions") }),
        );

        // Saving is asynchronous. Its completion signal must follow the durable
        // write even while another browser document holds the world lock.
        let markHeld!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        const held = new Promise<void>((resolve) => {
          markHeld = resolve;
        });
        const lock = vault.withWorldLock(world.id, "exclusive", async () => {
          markHeld();
          await gate;
        });
        await held;
        fireEvent.click(
          screen.getByRole("button", { name: i18n.t("common.save") }),
        );
        expect(onSave).not.toHaveBeenCalled();
        expect((await vault.getWorld(world.id))?.metadata?.dimensions).toEqual({
          alarm,
        });
        releaseSave!();
        await lock;
        await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
        expect(mocks.updateWorld).toHaveBeenCalledWith(world.id, {
          dimensions,
        });
        expect(onSave.mock.calls[0]?.[0].metadata.dimensions).toEqual(
          dimensions,
        );
        unmount();
        invalidateAllWorldRecords();
        vault.close();
        vault = new BrowserVault({ dbName });
        service = new LocalDataService(vault);
        expect((await service.getWorld(world.id))?.dimensions).toEqual(
          dimensions,
        );
        const reopened = openEditor(false, world, true);
        expect(
          JSON.parse(
            (
              await screen.findByLabelText<HTMLTextAreaElement>(
                i18n.t("world.dimensionDefinitions"),
                { selector: "textarea" },
              )
            ).value,
          ),
        ).toEqual(dimensions);
        reopened.unmount();
        await service.createSession(world.id, "edited-session", [], "en-US");
        await service.syncToServer("edited-session");
        expect((await mirror.getWorld(world.id))?.dimensions).toEqual(
          dimensions,
        );
        expect((await mirror.getWorld(world.id))?.metadata?.dimensions).toEqual(
          dimensions,
        );
        await service.commitFromServer("edited-session", "opening");
        vault.close();
        vault = new BrowserVault({ dbName });
        expect(
          (await new LocalDataService(vault).getWorld(world.id))?.dimensions,
        ).toEqual(dimensions);
      } finally {
        releaseSave?.();
        await vault.deleteDatabase();
        await mirror.close();
      }
    },
  );

  it("saves a dimension patch while preserving authored selection and pitch", async () => {
    const { onSave } = openEditor();
    mocks.updateWorld.mockImplementation(
      async (_id: string, patch: Partial<WorldRecord>) => ({
        ...world,
        ...patch,
      }),
    );
    changeOpening("At the harbor");
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("common.save") }),
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(mocks.updateWorld.mock.calls[0]?.[1]).not.toHaveProperty("metadata");
    expect(onSave.mock.calls[0]?.[0].metadata).toEqual(world.metadata);
  });

  it("cancels immediately and permits reload when untouched", () => {
    const { onCancel } = openEditor();
    expect(unload()).toBe(false);
    cancel();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(mocks.requestConfirm).not.toHaveBeenCalled();
  });

  it("leaves for the world list from the topbar, asking first when edited", async () => {
    const { onExit } = openEditor();
    changeOpening("At the harbor");
    await act(async () => emitWorldListRequest());
    await waitFor(() => expect(mocks.requestConfirm).toHaveBeenCalledOnce());
    expect(onExit).not.toHaveBeenCalled();
    mocks.requestConfirm.mockResolvedValue(true);
    await act(async () => emitWorldListRequest());
    await waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });

  it.each(["push", "back"] as const)(
    "guards in-app %s navigation until discard is confirmed",
    async (navigation) => {
      const { history } = openEditor(navigation === "back");
      changeOpening("At the harbor");
      const leave = () =>
        navigation === "push" ? history.push("/elsewhere") : history.back();
      await act(async () => leave());
      await waitFor(() => expect(mocks.requestConfirm).toHaveBeenCalledOnce());
      // The router undoes a blocked back step with a forward step once the
      // dialog closes. Leaving again before that step lands is undone by it.
      if (navigation === "back") {
        await waitFor(() => expect(window.location.pathname).toBe("/editor"));
      }
      expect(history.location.pathname).toBe("/editor");
      expect(
        (
          screen.getByLabelText(
            i18n.t("world.openingScenario"),
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("At the harbor");
      mocks.requestConfirm.mockResolvedValue(true);
      await act(async () => leave());
      await waitFor(() => expect(history.location.pathname).toBe("/elsewhere"));
    },
  );

  it("asks again when the player leaves before the editor re-renders", async () => {
    const { history } = openEditor();
    changeOpening("At the harbor");
    let keepEditing!: (discard: boolean) => void;
    mocks.requestConfirm.mockReturnValueOnce(
      new Promise<boolean>((resolve) => (keepEditing = resolve)),
    );
    await act(async () => history.push("/elsewhere"));
    await waitFor(() => expect(mocks.requestConfirm).toHaveBeenCalledOnce());
    mocks.requestConfirm.mockResolvedValue(true);
    // The router still holds the guard of the render that opened the dialog.
    keepEditing(false);
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    history.push("/elsewhere");
    await waitFor(() => expect(history.location.pathname).toBe("/elsewhere"));
    expect(mocks.requestConfirm).toHaveBeenCalledTimes(2);
  });

  it("does not block clean or reverted navigation and removes the blocker on unmount", async () => {
    const { history, unmount } = openEditor();
    changeOpening("At the harbor");
    changeOpening("At the gate");
    await act(async () => history.push("/elsewhere"));
    expect(history.location.pathname).toBe("/elsewhere");
    expect(mocks.requestConfirm).not.toHaveBeenCalled();
    changeOpening("Another edit");
    unmount();
    await act(async () => history.push("/editor"));
    expect(history.location.pathname).toBe("/editor");
    expect(mocks.requestConfirm).not.toHaveBeenCalled();
  });

  it("keeps invalid JSON safe on navigation", async () => {
    const { history } = openEditor();
    fireEvent.change(
      screen.getByLabelText(i18n.t("world.dimensionDefinitions"), {
        selector: "textarea",
      }),
      { target: { value: "{" } },
    );
    await act(async () => history.push("/elsewhere"));
    expect(history.location.pathname).toBe("/editor");
    expect(mocks.requestConfirm).toHaveBeenCalledOnce();
  });

  it("keeps edits when discard is declined, and exits when confirmed", async () => {
    const { onCancel } = openEditor();
    changeOpening("At the harbor");
    cancel();
    await waitFor(() => expect(mocks.requestConfirm).toHaveBeenCalledOnce());
    expect(mocks.requestConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: i18n.t("world.discardChangesTitle"),
        message: i18n.t("world.discardChangesMessage"),
        destructive: true,
      }),
    );
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      (
        screen.getByLabelText(
          i18n.t("world.openingScenario"),
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("At the harbor");
    mocks.requestConfirm.mockResolvedValue(true);
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: i18n.t("common.cancel"),
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    cancel();
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });

  it("protects invalid resource rows even when they cannot be merged", async () => {
    const { onCancel } = openEditor();
    selectStartingConditions();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("world.addResource_kv") }),
    );
    expect(
      (screen.getByLabelText(`${i18n.t("world.key")} 2`) as HTMLInputElement)
        .value,
    ).toBe("");
    expect(unload()).toBe(true);
    cancel();
    await waitFor(() => expect(mocks.requestConfirm).toHaveBeenCalledOnce());
    expect(onCancel).not.toHaveBeenCalled();
    expect(mocks.updateWorld).not.toHaveBeenCalled();
  });

  it("protects unapplied invalid JSON, and permits reload after reverting it", async () => {
    const { onCancel } = openEditor();
    const input = screen.getByLabelText(i18n.t("world.dimensionDefinitions"), {
      selector: "textarea",
    }) as HTMLTextAreaElement;
    const original = input.value;
    fireEvent.change(input, { target: { value: "{" } });
    expect(unload()).toBe(true);
    cancel();
    await waitFor(() => expect(mocks.requestConfirm).toHaveBeenCalledOnce());
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: original } });
    expect(unload()).toBe(false);
  });

  it("removes the reload guard after reverting form edits or unmounting", () => {
    const { unmount } = openEditor();
    changeOpening("At the harbor");
    expect(unload()).toBe(true);
    changeOpening("At the gate");
    expect(unload()).toBe(false);
    changeOpening("At the harbor");
    unmount();
    expect(unload()).toBe(false);
  });

  it.each([true, false])(
    "clears unsaved state only if saving succeeds (%s)",
    async (success) => {
      const { onSave, onCancel } = openEditor();
      changeOpening("At the harbor");
      if (!success)
        mocks.updateWorld.mockRejectedValue(new Error("Save failed"));
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("common.save") }),
      );
      await waitFor(() => {
        if (success) expect(onSave).toHaveBeenCalledWith(world);
        else expect(screen.getByText("Save failed")).toBeTruthy();
        expect(
          (
            screen.getByRole("button", {
              name: i18n.t("common.save"),
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false);
        // The saved snapshot and its reload-guard effect must both settle.
        expect(unload()).toBe(!success);
      });
      cancel();
      if (success) {
        expect(onSave).toHaveBeenCalledWith(world);
        expect(onCancel).toHaveBeenCalledOnce();
        expect(mocks.requestConfirm).not.toHaveBeenCalled();
        changeOpening("A later edit");
        expect(unload()).toBe(true);
      } else {
        await waitFor(() =>
          expect(mocks.requestConfirm).toHaveBeenCalledOnce(),
        );
        expect(onSave).not.toHaveBeenCalled();
        expect(onCancel).not.toHaveBeenCalled();
      }
    },
  );

  it("ignores a pending discard answer after this editor unmounts", async () => {
    let answer!: (value: boolean) => void;
    mocks.requestConfirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    const { onCancel, unmount } = openEditor();
    changeOpening("At the harbor");
    cancel();
    unmount();
    await act(async () => answer(true));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
