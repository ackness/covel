import { act, renderHook } from "@testing-library/react";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPlugin, SessionRecord } from "@/services/api.js";
import {
  SessionWorkspaceSyncError,
  type DataService,
  type SessionWorkspace,
} from "@/services/data-service.js";
import { useBuildSessionActions } from "../actions.js";
import { initialState, reducer } from "../reducer.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";
import { rehydrateSessionSideState } from "../subscription.js";

const api = vi.hoisted(() => ({
  listSessionPlugins: vi.fn(),
  listPluginData: vi.fn(),
  getSessionView: vi.fn(),
  listSuspensions: vi.fn(),
  enableSessionPlugin: vi.fn(),
  disableSessionPlugin: vi.fn(),
  resolveApproval: vi.fn(),
}));
const confirmation = vi.hoisted(() => ({
  requestConfirm: vi.fn(),
  requestChoices: vi.fn(),
}));
vi.mock("@/services/api", () => api);
vi.mock("@/lib/confirm-channel.js", () => confirmation);

const session: SessionRecord = {
  id: "session-a",
  worldId: "world-1",
  status: "active",
  phase: "playing",
  completedPlayerTurns: 1,
  setupRuntimes: {},
  activePlugins: [],
  locale: "en-US",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
const plugin: SessionPlugin = {
  serverCodeApproved: true,
  sessionState: "active",
  requires: [],
  optional: [],
  conflicts: [],
  extensions: [],
  id: "shared-plugin",
  displayName: "Shared plugin",
  description: "",
  kind: "plugin",
  source: "community",
  hostState: "loaded",
  runtimeCount: 0,
  provides: [],
  tags: [],
  runtimes: [],
  tools: [],
  userSettings: [],
  languages: { text: ["en"], instructions: ["en"] },
  active: false,
  locked: false,
};
const approval = {
  status: "approval-required",
  approvalId: "approval-a",
  pending: { pluginId: plugin.id, action: "plugin.enable" },
};
const enabled = { ok: true, activePluginIds: [plugin.id] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(active = false) {
  const run: SessionWorkspace["run"] = (_sid, _actionId, mutate) => mutate();
  const workspace = {
    run: vi.fn(run),
    hydrate: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => {}),
  };
  const hook = renderHook(() => {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      session,
      sessionPlugins: [{ ...plugin, active }],
    });
    const refs = useSessionRuntimeRefs(state);
    const actions = useBuildSessionActions({
      state,
      dispatch,
      refs,
      workspace: workspace as SessionWorkspace,
      ds: {} as DataService,
      handleSseEvent: vi.fn(),
    });
    return { actions, state, dispatch };
  });
  const visit = (nextId: string, nextActive = true) => {
    act(() => {
      hook.result.current.actions.backToWorldSelect();
      hook.result.current.dispatch({
        type: "SET_SESSION",
        session: { ...session, id: nextId },
      });
      hook.result.current.dispatch({
        type: "LOAD_SESSION_PLUGINS",
        plugins: [{ ...plugin, active: nextActive }],
      });
    });
  };
  return { ...hook, workspace, visit };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.enableSessionPlugin.mockResolvedValue(enabled);
  api.disableSessionPlugin.mockResolvedValue({ ok: true, activePluginIds: [] });
  api.resolveApproval.mockResolvedValue(undefined);
  confirmation.requestConfirm.mockResolvedValue(true);
  // The entry prompt authorizes whatever it was asked about.
  confirmation.requestChoices.mockImplementation(
    async (request: { choices: { id: string }[] }) =>
      request.choices.map((choice) => choice.id),
  );
});

describe.each(["session-b", "session-a"])(
  "plugin operations after navigating to %s",
  (nextId) => {
    it.each([
      { enable: true, stage: "hydrate" as const },
      { enable: false, stage: "hydrate" as const },
      { enable: true, stage: "checkpoint" as const },
      { enable: false, stage: "checkpoint" as const },
    ])(
      "ignores a late $stage failure when enable is $enable",
      async ({ enable, stage }) => {
        const { result, workspace, visit } = setup(!enable);
        const response = deferred<never>();
        workspace.run.mockReturnValueOnce(response.promise);
        let toggling!: Promise<void>;
        act(() => {
          toggling = result.current.actions.toggleSessionPlugin(
            plugin.id,
            enable,
          );
        });
        visit(nextId, enable);
        await act(async () => {
          response.reject(
            new SessionWorkspaceSyncError(
              stage,
              session.id,
              undefined,
              new Error("Old visit failed"),
            ),
          );
          await toggling;
        });
        expect(result.current.state.session?.id).toBe(nextId);
        expect(result.current.state.sessionPlugins[0]?.active).toBe(enable);
        expect(result.current.state.executionError).toBeNull();
      },
    );

    it("denies a late approval without displaying its prompt", async () => {
      const { result, visit } = setup();
      const response = deferred<typeof approval>();
      api.enableSessionPlugin.mockReturnValueOnce(response.promise);
      let toggling!: Promise<void>;
      act(() => {
        toggling = result.current.actions.toggleSessionPlugin(plugin.id, true);
      });
      visit(nextId);
      await act(async () => {
        response.resolve(approval);
        await toggling;
      });
      expect(confirmation.requestConfirm).not.toHaveBeenCalled();
      expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith(
        approval.approvalId,
        "deny",
        "session",
        session.id,
      );
      expect(result.current.state.sessionPlugins[0]?.active).toBe(true);
      expect(result.current.state.executionError).toBeNull();
    });

    it.each([false, true])(
      "denies an old prompt answered %s without changing the current visit",
      async (answer) => {
        const { result, visit } = setup();
        const response = deferred<boolean>();
        api.enableSessionPlugin.mockResolvedValueOnce(approval);
        confirmation.requestConfirm.mockReturnValueOnce(response.promise);
        let toggling!: Promise<void>;
        await act(async () => {
          toggling = result.current.actions.toggleSessionPlugin(
            plugin.id,
            true,
          );
        });
        expect(confirmation.requestConfirm).toHaveBeenCalledOnce();
        visit(nextId);
        await act(async () => {
          response.resolve(answer);
          await toggling;
        });
        expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith(
          approval.approvalId,
          "deny",
          "session",
          session.id,
        );
        expect(api.enableSessionPlugin).toHaveBeenCalledOnce();
        expect(result.current.state.sessionPlugins[0]?.active).toBe(true);
        expect(result.current.state.executionError).toBeNull();
      },
    );

    it("denies approval if navigation occurs while its workspace job waits", async () => {
      const { result, workspace, visit } = setup();
      const pending = deferred<void>();
      api.enableSessionPlugin.mockResolvedValueOnce(approval);
      workspace.run
        .mockImplementationOnce((_sid, _actionId, mutate) => mutate())
        .mockImplementationOnce(async (_sid, _actionId, mutate) => {
          await pending.promise;
          return mutate();
        });
      let toggling!: Promise<void>;
      await act(async () => {
        toggling = result.current.actions.toggleSessionPlugin(plugin.id, true);
      });
      expect(workspace.run).toHaveBeenCalledTimes(2);
      visit(nextId);
      await act(async () => {
        pending.resolve();
        await toggling;
      });
      expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith(
        approval.approvalId,
        "deny",
        "session",
        session.id,
      );
      expect(api.enableSessionPlugin).toHaveBeenCalledOnce();
      expect(result.current.state.sessionPlugins[0]?.active).toBe(true);
    });
  },
);

describe("plugin operations in the current visit", () => {
  it.each([false, true])(
    "publishes active=%s only after the server mutation",
    async (enable) => {
      const { result } = setup(!enable);
      const response = deferred<typeof enabled>();
      (enable
        ? api.enableSessionPlugin
        : api.disableSessionPlugin
      ).mockReturnValueOnce(response.promise);
      let toggling!: Promise<void>;
      await act(async () => {
        toggling = result.current.actions.toggleSessionPlugin(
          plugin.id,
          enable,
        );
      });
      expect(result.current.state.sessionPlugins[0]?.active).toBe(!enable);
      await act(async () => {
        response.resolve({
          ok: true,
          activePluginIds: enable ? [plugin.id] : [],
        });
        await toggling;
      });
      expect(result.current.state.sessionPlugins[0]?.active).toBe(enable);
    },
  );

  it.each([false, true])(
    "honors an approval answer of %s",
    async (approved) => {
      const { result } = setup();
      api.enableSessionPlugin.mockResolvedValueOnce(approval);
      confirmation.requestConfirm.mockResolvedValueOnce(approved);
      await act(async () => {
        await result.current.actions.toggleSessionPlugin(plugin.id, true);
      });
      expect(api.resolveApproval).toHaveBeenCalledExactlyOnceWith(
        approval.approvalId,
        approved ? "allow" : "deny",
        "session",
        session.id,
      );
      expect(api.enableSessionPlugin).toHaveBeenCalledTimes(approved ? 2 : 1);
      expect(result.current.state.sessionPlugins[0]?.active).toBe(approved);
    },
  );

  it("keeps the plugin inactive and reports a current hydrate failure", async () => {
    const { result, workspace } = setup();
    workspace.run.mockRejectedValueOnce(
      new SessionWorkspaceSyncError(
        "hydrate",
        session.id,
        undefined,
        new Error("Current visit failed"),
      ),
    );
    await act(async () => {
      await result.current.actions.toggleSessionPlugin(plugin.id, true);
    });
    expect(result.current.state.sessionPlugins[0]?.active).toBe(false);
    expect(result.current.state.executionError).toBe("Current visit failed");
  });
});

it("requests authorization once per visit for a restored selection and keeps denial visible", async () => {
  const { result } = setup();
  api.enableSessionPlugin.mockResolvedValue(approval);
  confirmation.requestChoices.mockResolvedValue([]);
  await act(async () => {
    result.current.dispatch({
      type: "LOAD_SESSION_PLUGINS",
      plugins: [{ ...plugin, active: false, approvalRequired: true }],
    });
  });
  expect(confirmation.requestChoices).toHaveBeenCalledTimes(1);
  expect(result.current.state.sessionPlugins[0]?.approvalRequired).toBe(true);
  await act(async () => {
    result.current.dispatch({
      type: "LOAD_SESSION_PLUGINS",
      plugins: [{ ...plugin, active: false, approvalRequired: true }],
    });
  });
  expect(confirmation.requestChoices).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.actions.toggleSessionPlugin(plugin.id, false);
  });
  expect(result.current.state.sessionPlugins[0]?.approvalRequired).toBe(false);
});

it("activates the selected community plugin after explicit approval on entry", async () => {
  const { result } = setup();
  api.enableSessionPlugin
    .mockResolvedValueOnce(approval)
    .mockResolvedValueOnce(enabled);
  await act(async () => {
    result.current.dispatch({
      type: "LOAD_SESSION_PLUGINS",
      plugins: [{ ...plugin, active: false, approvalRequired: true }],
    });
  });
  expect(confirmation.requestChoices).toHaveBeenCalledTimes(1);
  expect(api.resolveApproval).toHaveBeenCalledWith(
    approval.approvalId,
    "allow",
    "session",
    session.id,
  );
  expect(result.current.state.sessionPlugins[0]).toMatchObject({
    active: true,
    approvalRequired: false,
  });
});

describe("authorizing several paused plugins on entry", () => {
  const second: SessionPlugin = {
    ...plugin,
    id: "second-plugin",
    displayName: { "en-US": "Second plugin" },
    description: "Adds a map panel",
    version: "1.2.0",
  };
  const unnamed: SessionPlugin = {
    ...plugin,
    id: "unnamed-plugin",
    displayName: "",
  };
  // Like the server: a plugin needs approval until its own request is allowed.
  const serverLike = () =>
    api.enableSessionPlugin.mockImplementation(async (_sid, pluginId) =>
      api.resolveApproval.mock.calls.some(
        ([approvalId, decision]) =>
          approvalId === `approval-${pluginId}` && decision === "allow",
      )
        ? { ok: true, activePluginIds: [pluginId] }
        : {
            status: "approval-required",
            approvalId: `approval-${pluginId}`,
            pending: { pluginId, action: "plugin.enable" },
          },
    );
  const enter = (result: ReturnType<typeof setup>["result"]) =>
    act(async () => {
      result.current.dispatch({
        type: "LOAD_SESSION_PLUGINS",
        plugins: [plugin, second, unnamed].map((entry) => ({
          ...entry,
          active: false,
          approvalRequired: true,
        })),
      });
    });

  it("asks once, naming each plugin, before any approval is requested", async () => {
    const { result } = setup();
    serverLike();
    confirmation.requestChoices.mockImplementation(async (request) => {
      expect(api.enableSessionPlugin).not.toHaveBeenCalled();
      return request.choices.map((choice: { id: string }) => choice.id);
    });

    await enter(result);

    expect(confirmation.requestConfirm).not.toHaveBeenCalled();
    expect(confirmation.requestChoices).toHaveBeenCalledTimes(1);
    expect(confirmation.requestChoices.mock.calls[0]![0].choices).toEqual([
      { id: plugin.id, label: "Shared plugin", detail: plugin.id },
      {
        id: second.id,
        label: "Second plugin",
        detail: "second-plugin · 1.2.0 — Adds a map panel",
      },
      { id: unnamed.id, label: unnamed.id, detail: "" },
    ]);
    // Each plugin is requested, allowed and enabled before the next begins,
    // because enabling one drops the others' pending requests on the server.
    expect(api.resolveApproval.mock.calls).toEqual(
      [plugin, second, unnamed].map((entry) => [
        `approval-${entry.id}`,
        "allow",
        "session",
        session.id,
      ]),
    );
    expect(
      result.current.state.sessionPlugins.map((entry) => entry.active),
    ).toEqual([true, true, true]);
  });

  it("requests nothing for a plugin the player unticked", async () => {
    const { result } = setup();
    serverLike();
    confirmation.requestChoices.mockResolvedValue([second.id]);

    await enter(result);

    expect(
      api.enableSessionPlugin.mock.calls.map(([, pluginId]) => pluginId),
    ).toEqual([second.id, second.id]);
    expect(api.resolveApproval.mock.calls).toEqual([
      [`approval-${second.id}`, "allow", "session", session.id],
    ]);
    expect(
      result.current.state.sessionPlugins.map((entry) => entry.active),
    ).toEqual([false, true, false]);
  });

  it("refuses a request that is about another plugin than the one consented to", async () => {
    const { result } = setup();
    api.enableSessionPlugin.mockResolvedValue({
      status: "approval-required",
      approvalId: "approval-other",
      pending: { pluginId: "other-plugin", action: "plugin.enable" },
    });
    confirmation.requestChoices.mockResolvedValue([plugin.id]);

    await enter(result);

    expect(api.resolveApproval.mock.calls).toEqual([
      ["approval-other", "deny", "session", session.id],
    ]);
    expect(result.current.state.sessionPlugins[0]?.active).toBe(false);
  });
});

const catalog = (name: string) => ({
  items: [{ ...plugin, displayName: name }],
  commands: [{ id: name, label: name, pluginId: plugin.id }],
});

it("F-009: ignores a plugin GET from an earlier visit to the same session", async () => {
  const old = deferred<ReturnType<typeof catalog>>();
  api.listSessionPlugins
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue(catalog("New"));
  const { result, visit } = setup();
  let loading!: Promise<void>;
  act(() => {
    loading = result.current.actions.loadSessionPlugins();
  });
  visit("session-b");
  visit("session-a");
  await act(async () => {
    await result.current.actions.loadSessionPlugins();
  });
  await act(async () => {
    old.resolve(catalog("Old"));
    await loading;
  });
  expect(result.current.state.sessionPlugins[0]?.displayName).toBe("New");
  expect(result.current.state.sessionCommands).toEqual(catalog("New").commands);
});

it("F-009: the latest plugin GET owns plugins and commands within one visit", async () => {
  const old = deferred<ReturnType<typeof catalog>>();
  api.listSessionPlugins
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue(catalog("New"));
  const { result } = setup();
  let loading!: Promise<void>;
  act(() => {
    loading = result.current.actions.loadSessionPlugins();
  });
  await act(async () => {
    await result.current.actions.loadSessionPlugins();
  });
  await act(async () => {
    old.resolve(catalog("Old"));
    await loading;
  });
  expect(result.current.state.sessionPlugins[0]?.displayName).toBe("New");
  expect(result.current.state.sessionCommands).toEqual(catalog("New").commands);
});

it.each(["GET", "reconnect"])(
  "F-009: the latest %s read owns the shared plugin resource",
  async (latest) => {
    api.getSessionView.mockResolvedValue({
      session,
      messages: [],
      characters: [],
      gameState: {},
      executionSteps: [],
    });
    api.listSuspensions.mockResolvedValue([]);
    const old = deferred<ReturnType<typeof catalog>>();
    api.listSessionPlugins
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(catalog("New"));
    const { result } = setup();
    const reconnect = () =>
      rehydrateSessionSideState(
        session.id,
        { current: session.id },
        result.current.dispatch,
      );
    let loading!: Promise<void>;
    act(() => {
      loading =
        latest === "GET"
          ? reconnect()
          : result.current.actions.loadSessionPlugins();
    });
    await act(async () => {
      await (latest === "GET"
        ? result.current.actions.loadSessionPlugins()
        : reconnect());
    });
    await act(async () => {
      old.resolve(catalog("Old"));
      await loading;
    });
    expect(result.current.state.sessionPlugins[0]?.displayName).toBe("New");
    expect(result.current.state.sessionCommands).toEqual(
      catalog("New").commands,
    );
  },
);
