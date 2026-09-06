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

const api = vi.hoisted(() => ({
  enableSessionPlugin: vi.fn(),
  disableSessionPlugin: vi.fn(),
  resolveApproval: vi.fn(),
}));
const confirmation = vi.hoisted(() => ({ requestConfirm: vi.fn() }));
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
  id: "shared-plugin",
  displayName: "Shared plugin",
  description: "",
  pluginType: "plugin",
  source: "community",
  status: "registered",
  runtimeCount: 0,
  capabilities: [],
  tags: [],
  runtimes: [],
  tools: [],
  userSettings: [],
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

  it("still rolls back and reports a current hydrate failure", async () => {
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
