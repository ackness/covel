import { useReducer } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/services/api";
import {
  SessionWorkspaceSyncError,
  type SessionWorkspace,
  type DataService,
} from "@/services/data-service.js";
import { useBuildSessionActions } from "../actions.js";
import { initialState, reducer } from "../reducer.js";
import { createSseEventHandler } from "../sse-handler.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";

const session: api.SessionRecord = {
  id: "session-1",
  worldId: "world-1",
  status: "active",
  phase: "playing",
  completedPlayerTurns: 1,
  setupRuntimes: {},
  activePlugins: [],
  locale: "en-US",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function event(
  type: api.SseEnvelope["type"],
  turnId: string,
  payload: Record<string, unknown>,
): api.SseEnvelope {
  return {
    type,
    turnId,
    payload,
    sessionId: session.id,
    requestId: `request-${turnId}`,
    traceId: "trace-1",
    flowId: "flow-1",
    seq: 1,
    timestamp: "2026-01-01T00:00:01Z",
  };
}

function renderActions(
  workspace: SessionWorkspace,
  recovery = initialState.executionRecovery,
) {
  const ds = { addMessage: vi.fn(async () => {}) } as unknown as DataService;
  return renderHook(() => {
    const [state, dispatch] = useReducer(reducer, {
      ...initialState,
      session,
      executionRecovery: recovery,
      world: {
        id: "world-1",
        name: "Test world",
        description: "",
        createdAt: session.createdAt,
      },
    });
    const refs = useSessionRuntimeRefs(state);
    const handleSseEvent = createSseEventHandler({ ...refs, dispatch, ds });
    return {
      state,
      actions: useBuildSessionActions({
        state,
        dispatch,
        ds,
        workspace,
        refs,
        handleSseEvent,
      }),
    };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "getSession").mockResolvedValue(session);
  vi.spyOn(api, "getWorldOverlay").mockResolvedValue(null);
});

describe("same-session action ownership", () => {
  it.each([
    { first: "kernel", fails: false },
    { first: "send", fails: false },
    { first: "start", fails: false },
    { first: "kernel", fails: true },
  ])(
    "does not let a delayed $first workspace completion (failure: $fails) settle the next action",
    async ({ first, fails }) => {
      const pendingCommit = deferred();
      let calls = 0;
      const run: SessionWorkspace["run"] = async (_sid, _request, mutate) => {
        const index = calls++;
        const value = await mutate();
        if (index === 0) {
          await pendingCommit.promise;
          if (fails)
            throw new SessionWorkspaceSyncError(
              "checkpoint",
              session.id,
              "old-request",
              new Error("Old checkpoint failed"),
            );
        }
        return value;
      };
      const workspace: SessionWorkspace = {
        run,
        hydrate: vi.fn(),
        checkpoint: vi.fn(),
      };
      const send = vi
        .spyOn(api, "sendAction")
        .mockImplementation(() => new AbortController());
      const { result } = renderActions(workspace);
      await act(async () => {
        if (first === "start") result.current.actions.beginAdventure();
        else if (first === "send")
          result.current.actions.sendMessage("Original input");
        else
          result.current.actions.retryRuntime(
            ["tracker-a", "tracker-b"],
            "source-turn",
          );
      });
      expect(send).toHaveBeenCalledOnce();
      const [, oldEvent, , oldDone] = send.mock.calls[0]!;
      await act(async () => {
        oldEvent(
          event("execution.completed", "old-attempt", { committed: true }),
        );
        oldDone?.();
      });
      expect(result.current.state.executing).toBe(false);

      await act(async () =>
        result.current.actions.retryRuntime("tracker-b", "source-turn"),
      );
      expect(send).toHaveBeenCalledTimes(2);
      const [, nextEvent, , nextDone] = send.mock.calls[1]!;
      act(() =>
        nextEvent(
          event("runtime.started", "new-attempt", {
            runtimeId: "tracker-b",
            pluginId: "test-plugin",
            sourceTurnId: "source-turn",
          }),
        ),
      );
      await act(async () => pendingCommit.resolve());
      expect(result.current.state.executing).toBe(true);
      expect(result.current.state.executionError).toBeNull();
      expect(result.current.state.executionSteps).toContainEqual(
        expect.objectContaining({
          turnId: "new-attempt",
          runtimeId: "tracker-b",
          status: "running",
        }),
      );
      expect(api.getSession).not.toHaveBeenCalled();

      // Old callbacks may arrive after the workspace has returned as well.
      act(() =>
        oldEvent(
          event("execution.completed", "old-attempt", { committed: false }),
        ),
      );
      expect(result.current.state.executing).toBe(true);
      expect(result.current.state.executionRecovery).toBeNull();
      await act(async () => {
        nextEvent(
          event("execution.completed", "new-attempt", { committed: true }),
        );
        nextDone?.();
      });
      expect(result.current.state.executing).toBe(false);
      expect(api.getSession).toHaveBeenCalledOnce();
    },
  );

  it("does not create an empty player turn when no failed task is selected", () => {
    const workspace: SessionWorkspace = {
      run: async (_sid, _request, mutate) => mutate(),
      hydrate: vi.fn(),
      checkpoint: vi.fn(),
    };
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const { result } = renderActions(workspace);
    act(() => result.current.actions.retryRuntime());
    expect(send).not.toHaveBeenCalled();
    expect(result.current.state.executing).toBe(false);
  });

  it("retries a failed uncommitted action with its original type and input", async () => {
    const workspace: SessionWorkspace = {
      run: async (_sid, _request, mutate) => mutate(),
      hydrate: vi.fn(),
      checkpoint: vi.fn(),
    };
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const { result } = renderActions(workspace, {
      sessionId: session.id,
      checking: false,
      hydrating: false,
      status: {
        state: "failed",
        turnId: "failed-turn",
        retry: {
          type: "send_message",
          payload: { content: "Keep this exact player input" },
        },
      },
    });
    act(() => result.current.actions.retryRuntime("tracker-b", "failed-turn"));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        type: "send_message",
        payload: {
          content: "Keep this exact player input",
          recoverFromTurnId: "failed-turn",
        },
      }),
    );
    await act(async () => {
      send.mock.calls[0]![1](
        event("execution.completed", "recovered-turn", { committed: true }),
      );
      send.mock.calls[0]![3]?.();
    });
  });
});
