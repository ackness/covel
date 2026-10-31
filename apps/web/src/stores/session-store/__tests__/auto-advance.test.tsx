import { useReducer } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/services/api.js";
import { createSessionWorkspace } from "@/services/data-service/workspace.js";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import { initialState, reducer } from "../reducer.js";
import { useSessionRuntimeRefs } from "../runtime-refs.js";
import { useBuildSessionActions } from "../actions.js";
import { createSseEventHandler } from "../sse-handler.js";

const session: api.SessionRecord = {
  id: "s",
  worldId: "w",
  status: "active",
  phase: "playing",
  locale: "en-US",
  autoAdvanceLimit: 3,
  completedPlayerTurns: 4,
  setupRuntimes: {},
  seats: [
    { id: "human", role: "host", controller: "human", characters: "auto" },
  ],
  activePlugins: [],
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const progress = {
  requestId: "r",
  rootId: "root",
  phase: "running" as const,
  round: 1,
  limit: 3,
};
function envelope(
  type: string,
  payload: Record<string, unknown>,
  turnId = "auto",
): api.SseEnvelope {
  return {
    type,
    payload,
    turnId,
    requestId: "r",
    traceId: "trace",
    flowId: "flow",
    sessionId: "s",
    seq: 1,
    timestamp: "2026-01-01",
  };
}
function harness(workspace: SessionWorkspace) {
  const ds = {} as DataService;
  return renderHook(() => {
    const [state, dispatch] = useReducer(reducer, { ...initialState, session });
    const refs = useSessionRuntimeRefs(state);
    const handleSseEvent = createSseEventHandler({ ...refs, dispatch, ds });
    return {
      state,
      dispatch,
      handleSseEvent,
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
afterEach(() => vi.restoreAllMocks());
describe("advancement projection", () => {
  it("ends the running projection when a request fails before any execution starts", () => {
    const h = harness(createSessionWorkspace({} as DataService, "remote"));
    act(() =>
      h.result.current.dispatch({ type: "SET_EXECUTING", value: true }),
    );
    act(() =>
      h.result.current.handleSseEvent(
        envelope("error.occurred", { message: "Admission failed" }),
      ),
    );
    expect(h.result.current.state.executing).toBe(false);
    expect(h.result.current.state.advance).toBeNull();
  });
  it("settles only the named round and keeps prior committed stories after a later failure", () => {
    const workspace = createSessionWorkspace({} as DataService, "remote");
    const h = harness(workspace);
    act(() => {
      h.result.current.dispatch({ type: "SET_EXECUTING", value: true });
      h.result.current.handleSseEvent(
        envelope(
          "runtime.started",
          { runtimeId: "story", pluginId: "provider" },
          "root-turn",
        ),
      );
      h.result.current.dispatch({
        type: "ADD_MESSAGE",
        message: {
          id: "m",
          turnId: "root-turn",
          role: "assistant",
          content: "Saved story",
          timestamp: "2026-01-01",
        },
      });
      h.result.current.handleSseEvent(
        envelope("execution.round.completed", { committed: true }, "root-turn"),
      );
      h.result.current.handleSseEvent(
        envelope("runtime.started", {
          runtimeId: "story",
          pluginId: "provider",
        }),
      );
      h.result.current.handleSseEvent(envelope("execution.advance", progress));
    });
    expect(h.result.current.state.executing).toBe(true);
    expect(
      h.result.current.state.executionSteps.find(
        (step) => step.turnId === "auto",
      )?.status,
    ).toBe("running");
    act(() =>
      h.result.current.handleSseEvent(
        envelope("execution.round.completed", {
          committed: false,
          abortReason: "aborted-by-player",
        }),
      ),
    );
    expect(h.result.current.state.executing).toBe(true);
    expect(
      h.result.current.state.messages.map((message) => message.content),
    ).toEqual(["Saved story"]);
    act(() =>
      h.result.current.handleSseEvent(
        envelope("execution.completed", {
          committed: false,
          abortReason: "aborted-by-player",
        }),
      ),
    );
    expect(h.result.current.state.executing).toBe(false);
    expect(h.result.current.state.advance).toBeNull();
    expect(h.result.current.state.executionError).toBeNull();
  });
  it("ignores regressive progress and keeps the live indicator during unknown recovery", () => {
    let state = {
      ...initialState,
      session,
      executing: true,
      advance: progress,
    };
    state = reducer(state, {
      type: "SET_ADVANCE",
      advance: { ...progress, phase: "waiting" },
    }) as typeof state;
    expect(state.advance.phase).toBe("running");
    state = reducer(state, {
      type: "SET_EXECUTION_RECOVERY",
      recovery: {
        sessionId: "s",
        status: { state: "unknown" },
        checking: false,
        hydrating: false,
      },
    }) as typeof state;
    expect(state.advance).toEqual(progress);
    expect(state.executing).toBe(true);
    const ended = reducer(state, {
      type: "OBSERVE_EXECUTION_STATUS",
      sessionId: "s",
      status: { state: "completed" },
    });
    expect(ended.advance).toBeNull();
  });
});

describe("interrupt then submit", () => {
  it.each(["say", "direct", "narrate", "advance"])(
    "submits %s once after stopping and checkpointing the old owner",
    async (kind) => {
      let releaseCheckpoint!: () => void;
      const checkpoint = {
        promise: new Promise<void>((resolve) => {
          releaseCheckpoint = resolve;
        }),
        resolve: () => releaseCheckpoint(),
      };
      const order: string[] = [];
      let committing = false;
      const ds = {
        withSessionWorkspace: async (
          _id: string,
          run: (ops: unknown) => Promise<unknown>,
        ) =>
          run({
            persistInput: async () => {},
            hydrate: async () => {
              expect(committing).toBe(false);
              order.push("hydrate");
            },
            stage: async () => {},
            commit: async () => {
              committing = true;
              order.push("checkpoint");
              await checkpoint.promise;
              committing = false;
            },
          }),
      } as unknown as DataService;
      const workspace = createSessionWorkspace(ds, "local");
      const send = vi
        .spyOn(api, "sendAction")
        .mockImplementation(() => new AbortController());
      vi.spyOn(api, "getSession").mockResolvedValue(session);
      const h = harness(workspace);
      await act(async () => h.result.current.actions.sendMessage("Root"));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const old = send.mock.calls[0]!;
      act(() => {
        old[1](envelope("execution.started", {}, "root-turn"));
        old[1](envelope("execution.advance", progress));
      });
      vi.spyOn(api, "abortTurn").mockImplementation(async () => {
        order.push("stop");
        old[1](envelope("execution.completed", { committed: true }));
        old[3]?.();
        return true;
      });
      await act(async () =>
        h.result.current.actions.submitComposerAction({
          kind,
          ...(kind === "advance" ? {} : { text: "New action" }),
        }),
      );
      await waitFor(() => expect(order).toContain("checkpoint"));
      expect(send).toHaveBeenCalledTimes(1);
      expect(order.indexOf("stop")).toBeLessThan(order.indexOf("checkpoint"));
      await act(async () => checkpoint.resolve());
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls[1]?.[0]).toMatchObject({
        type: "submit_actions",
        payload: {
          actions: [
            { kind, ...(kind === "advance" ? {} : { text: "New action" }) },
          ],
        },
      });
      // Old terminal events cannot end or change the new request.
      act(() => old[1](envelope("execution.completed", { committed: false })));
      expect(h.result.current.state.executing).toBe(true);
    },
  );
  it.each(["stop", "checkpoint"])(
    "preserves structured draft fields when %s fails",
    async (stage) => {
      const abort = vi.spyOn(api, "abortTurn");
      if (stage === "stop") abort.mockRejectedValue(new Error("offline"));
      else abort.mockResolvedValue(true);
      const send = vi.spyOn(api, "sendAction");
      const workspace = createSessionWorkspace({} as DataService, "remote");
      if (stage === "checkpoint")
        vi.spyOn(workspace, "settle").mockRejectedValue(
          new Error("Checkpoint unavailable"),
        );
      const h = harness(workspace);
      act(() => {
        h.result.current.dispatch({ type: "SET_EXECUTING", value: true });
        h.result.current.dispatch({ type: "SET_ADVANCE", advance: progress });
      });
      await act(async () =>
        h.result.current.actions.submitComposerAction({
          kind: "direct",
          text: "Wait",
          fields: { target: "the gate" },
        }),
      );
      expect(send).not.toHaveBeenCalled();
      expect(h.result.current.state.restoredInput).toMatchObject({
        kind: "direct",
        content: "Wait",
        fields: { target: "the gate" },
      });
    },
  );
  it("allows another session's input while an old session's checkpoint settles", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workspace = createSessionWorkspace({} as DataService, "remote");
    vi.spyOn(workspace, "settle").mockImplementation(async (id) => {
      if (id === "s") await pending;
    });
    vi.spyOn(api, "abortTurn").mockResolvedValue(true);
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    const h = harness(workspace);
    act(() => {
      h.result.current.dispatch({ type: "SET_EXECUTING", value: true });
      h.result.current.dispatch({ type: "SET_ADVANCE", advance: progress });
    });
    await act(async () =>
      h.result.current.actions.submitComposerAction({
        kind: "direct",
        text: "Old input",
      }),
    );
    act(() => {
      h.result.current.dispatch({
        type: "SET_SESSION",
        session: { ...session, id: "next" },
      });
      h.result.current.dispatch({ type: "SET_EXECUTING", value: true });
      h.result.current.dispatch({
        type: "SET_ADVANCE",
        advance: {
          ...progress,
          requestId: "next-request",
          rootId: "next-root",
        },
      });
    });
    await act(async () =>
      h.result.current.actions.submitComposerAction({
        kind: "direct",
        text: "New input",
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "next",
      payload: { actions: [{ kind: "direct", text: "New input" }] },
    });
    await act(async () => release());
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.result.current.state.session?.id).toBe("next");
    expect(h.result.current.state.restoredInput).toBeNull();
  });
  it("restores fields after a streamed refusal before execution", async () => {
    const send = vi
      .spyOn(api, "sendAction")
      .mockImplementation(() => new AbortController());
    vi.spyOn(api, "getSession").mockResolvedValue(session);
    const h = harness(createSessionWorkspace({} as DataService, "remote"));
    await act(async () =>
      h.result.current.actions.submitComposerAction({
        kind: "direct",
        text: "Wait",
        fields: { target: "gate" },
      }),
    );
    const sent = send.mock.calls[0]!;
    await act(async () => {
      sent[1](
        envelope("error.occurred", {
          code: "invalid_action",
          message: "Refused",
        }),
      );
      sent[3]?.();
    });
    expect(h.result.current.state.restoredInput).toMatchObject({
      kind: "direct",
      content: "Wait",
      fields: { target: "gate" },
    });
    expect(h.result.current.state.messages).toEqual([]);
  });
});
