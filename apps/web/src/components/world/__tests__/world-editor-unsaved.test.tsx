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
import { WorldEditor } from "../world-editor.js";

const mocks = vi.hoisted(() => ({
  updateWorld: vi.fn(),
  requestConfirm: vi.fn(),
}));
vi.mock("@/services/data-service.js", () => ({ getDataService: () => mocks }));
vi.mock("@/lib/confirm-channel.js", () => ({
  requestConfirm: mocks.requestConfirm,
}));

const world: WorldRecord = {
  id: "draft-world",
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

function openEditor(browser = false) {
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
  const view = render(
    <RouterContextProvider router={router}>
      <WorldEditor
        world={world}
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
  for (const dispose of disposeHistories.splice(0)) dispose();
});

describe("WorldEditor unsaved changes", () => {
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
