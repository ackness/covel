import { useReducer, type ReactNode } from "react";
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/services/api.js";
import * as dataServices from "@/services/data-service.js";
import {
  SessionStateContext,
  SessionActionsContext,
} from "@/stores/session-store/context.js";
import { useBuildSessionActions } from "@/stores/session-store/actions.js";
import { useSessionRuntimeRefs } from "@/stores/session-store/runtime-refs.js";
import { createSseEventHandler } from "@/stores/session-store/sse-handler.js";
import { reducer } from "@/stores/session-store/reducer.js";
import { useSessionBridgeActions } from "../use-session-bridge-actions.js";
import { viewEntry } from "./plugin-view-fixtures.js";

vi.mock("@/stores/ui-slot-store.js", () => {
  const empty: [] = [];
  return {
    useUiSlots: () => empty,
    clearUiSlots: () => {},
    applyUiSlotEvent: () => false,
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
import type { PluginRpcResponse } from "@covel/shared";
import type { SessionActions } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type {
  SessionState,
  StreamMessage,
} from "@/stores/session-store/types.js";
import { createSessionBridgeActions } from "../session-bridge-actions.js";
import { createInteractionHandles } from "../session-bridge-interactions.js";
import {
  buildSessionProjection,
  createSessionMessageOrdinals,
} from "../session-bridge.js";
import { sessionPlugin } from "./plugin-view-fixtures.js";

const form: StreamMessage = {
  id: "internal-block",
  role: "assistant",
  content: "",
  timestamp: "private",
  turnId: "internal-turn",
  block: {
    type: "interactive_form",
    data: {
      interactionId: "internal-ref",
      title: "Public form",
      fields: [{ name: "name", label: "Name", type: "text" }],
      validation: { name: "private-validator", data: "private" },
      meta: "private",
    },
  },
};
function fixture() {
  let active = true;
  const state: SessionState = {
    ...initialState,
    session: {
      id: "session",
      worldId: "world",
      autoAdvanceLimit: 0,
      status: "active",
      phase: "playing",
      locale: "en-US",
      createdAt: "",
      updatedAt: "",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: ["p"],
    },
    sessionPlugins: [
      {
        ...sessionPlugin,
        runtimes: [
          {
            id: "p/write",
            runtimeType: "function",
            trigger: { type: "manual" },
            execution: "sync",
            turnCompletion: { mode: "await" },
            outputKind: "system",
          },
        ],
      },
    ],
    sessionActionKinds: {
      kinds: [
        {
          kind: "say",
          source: "framework",
          text: "required",
          actor: true,
          roles: ["player"],
          display: { label: "Say" },
        },
      ],
      seats: [
        {
          seatId: "main",
          role: "player",
          controller: "human",
          allowed: ["say"],
        },
      ],
    },
  };
  const handles = createInteractionHandles();
  const actions = {
    submitComposerAction: vi.fn(() => true),
    submitInteraction: vi.fn<SessionActions["submitInteraction"]>(async () => ({
      rejected: [],
      status: "accepted" as const,
    })),
    abortActiveTurn: vi.fn(async () => {}),
  };
  const invokeRuntime = vi.fn(
    async (
      _runtimeId: string,
      _payload: unknown,
      _isCurrent: () => boolean,
    ): Promise<PluginRpcResponse> => ({
      status: "ok",
      runtimeResults: [
        {
          pluginId: "p",
          runtimeId: "p/write",
          status: "success",
          durationMs: 1,
          output: {
            providerContinuation: "credential-sentinel",
            _hidden: { private: "secret" },
            effects: ["proposal-secret"],
          },
        },
      ],
    }),
  );
  const openPanel = vi.fn();
  const deps = {
    pluginId: "p",
    capabilities: [
      "submitAction",
      "submitInteraction",
      "invokeRuntime",
      "abortExecution",
      "openPanel",
    ] as const,
    read: () => state,
    isCurrent: () => active,
    handles,
    actions,
    invokeRuntime,
    ownPanels: () => ["notes"],
    openPanel,
  };
  const handlers = createSessionBridgeActions(deps);
  const invoke = (method: string, params: Record<string, unknown> = {}) =>
    handlers[method]!(params);
  return {
    state,
    handles,
    actions,
    invokeRuntime,
    openPanel,
    deps,
    invoke,
    retire: () => {
      active = false;
    },
  };
}

describe("session bridge actions", () => {
  it("uses real boolean admission and submits slash text as a player action", async () => {
    const f = fixture();
    expect(
      await f.invoke("submitAction", { kind: "say", text: "/not-a-command" }),
    ).toEqual({ status: "accepted" });
    expect(f.actions.submitComposerAction).toHaveBeenCalledWith(
      { kind: "say", text: "/not-a-command" },
      { isCurrent: expect.any(Function) },
    );
    f.actions.submitComposerAction.mockReturnValue(false);
    expect(
      await f.invoke("submitAction", { kind: "say", text: "Keep draft" }),
    ).toEqual({ status: "unavailable", code: "busy" });
  });
  it.each([
    "source",
    "actorId",
    "sessionId",
    "pluginId",
    "provider",
    "proposal",
    "modelOverride",
    "interaction",
    "path",
    "token",
  ])("rejects caller authority %s before dispatch", async (key) => {
    const f = fixture();
    expect(
      await f.invoke("submitAction", {
        kind: "say",
        text: "Hello",
        [key]: "forged",
      }),
    ).toEqual({ status: "rejected", code: "invalid-request" });
    expect(f.actions.submitComposerAction).not.toHaveBeenCalled();
    expect(
      await f.invoke("invokeRuntime", {
        runtimeId: "p/write",
        [key]: "forged",
      }),
    ).toEqual({ status: "rejected", code: "invalid-request" });
    expect(f.invokeRuntime).not.toHaveBeenCalled();
  });
  it("blocks normal input during required interactions and setup", async () => {
    const f = fixture();
    f.state.messages = [form];
    expect(
      await f.invoke("submitAction", { kind: "say", text: "Skip" }),
    ).toMatchObject({ status: "unavailable" });
    f.state.messages = [];
    f.state.session = { ...f.state.session!, phase: "setup" };
    expect(
      await f.invoke("submitAction", { kind: "say", text: "Skip" }),
    ).toMatchObject({ status: "unavailable" });
    expect(f.actions.submitComposerAction).not.toHaveBeenCalled();
  });
  it.each([
    ["form", form.block!],
    [
      "choice",
      {
        type: "interactive_choice",
        data: { choices: [{ id: "left", label: "Left" }] },
      },
    ],
    [
      "confirmation",
      { type: "interactive_confirmation", data: { prompt: "Continue?" } },
    ],
  ] as const)(
    "resolves %s handles only in the owning current frame",
    async (type, block) => {
      const f = fixture();
      const message = { ...form, block };
      f.state.messages = [message];
      const handle = f.handles.issue(message)!;
      expect(
        await f.invoke("submitInteraction", { handle, values: {} }),
      ).toEqual({ status: "accepted" });
      expect(f.actions.submitInteraction).toHaveBeenCalledWith(
        "internal-block",
        "internal-turn",
        type === "form" ? "internal-ref" : "form",
        type,
        {},
        { isCurrent: expect.any(Function) },
      );
      expect(
        await f.invoke("submitInteraction", { handle, values: {} }),
      ).toMatchObject({ status: "unavailable" });
      expect(f.actions.submitInteraction).toHaveBeenCalledTimes(1);
      expect(
        fixture().handles.resolve(handle, [message], new Set()),
      ).toBeUndefined();
    },
  );
  it("expires handles on replacement and preserves editable fields after validation refusal", async () => {
    const f = fixture();
    f.state.messages = [form];
    const handle = f.handles.issue(form)!;
    f.actions.submitInteraction.mockResolvedValueOnce({
      rejected: [{ field: "name", message: "provider credential-sentinel" }],
      status: undefined,
    } as never);
    expect(await f.invoke("submitInteraction", { handle, values: {} })).toEqual(
      {
        status: "rejected",
        code: "field-invalid",
        issues: [{ field: "name", code: "invalid" }],
      },
    );
    expect(f.handles.resolve(handle, [form], new Set())).toBeDefined();
    f.state.messages = [
      { ...form, block: { ...form.block, data: { fields: [] } } },
    ];
    expect(
      await f.invoke("submitInteraction", { handle, values: {} }),
    ).toMatchObject({ status: "unavailable" });
  });
  it("does not turn a missing admission outcome into success", async () => {
    const f = fixture();
    f.state.messages = [form];
    const handle = f.handles.issue(form)!;
    f.actions.submitInteraction.mockResolvedValueOnce(undefined as never);
    expect(
      await f.invoke("submitInteraction", { handle, values: {} }),
    ).toMatchObject({ status: "unavailable" });
  });
  it("keeps abort and own-panel navigation available during execution with separate grants", async () => {
    const f = fixture();
    f.state.executing = true;
    expect(await f.invoke("abortExecution")).toEqual({ status: "accepted" });
    expect(await f.invoke("openPanel", { panelId: "notes" })).toEqual({
      status: "accepted",
    });
    expect(
      await f.invoke("openPanel", { panelId: "foreign:settings" }),
    ).toMatchObject({ status: "unavailable" });
    expect(f.openPanel).toHaveBeenCalledExactlyOnceWith("notes");
    const denied = createSessionBridgeActions({ ...f.deps, capabilities: [] });
    expect(await denied.abortExecution!({})).toEqual({
      status: "rejected",
      code: "permission-denied",
    });
    expect(await denied.openPanel!({ panelId: "notes" })).toEqual({
      status: "rejected",
      code: "permission-denied",
    });
  });
  it("requires an active own manual runtime and returns only settlement facts", async () => {
    const f = fixture();
    for (const runtimeId of ["foreign/write", "missing"])
      expect(await f.invoke("invokeRuntime", { runtimeId })).toMatchObject({
        status: "unavailable",
      });
    expect(f.invokeRuntime).not.toHaveBeenCalled();
    expect(
      await f.invoke("invokeRuntime", {
        runtimeId: "p/write",
        payload: { text: "Public" },
      }),
    ).toEqual({ status: "committed" });
    f.invokeRuntime.mockResolvedValueOnce({
      status: "ok",
      abortReason: "credential-sentinel",
      result: { hidden: "secret" },
    });
    expect(await f.invoke("invokeRuntime", { runtimeId: "p/write" })).toEqual({
      status: "rejected",
      code: "runtime-refused",
    });
    f.state.sessionPlugins = [
      {
        ...f.state.sessionPlugins[0]!,
        runtimes: [
          { ...f.state.sessionPlugins[0]!.runtimes[0]!, subagentOnly: true },
        ],
      },
    ];
    expect(
      await f.invoke("invokeRuntime", { runtimeId: "p/write" }),
    ).toMatchObject({ status: "unavailable" });
  });
  it("retires before late runtime results and blocks deferred dispatch", async () => {
    const f = fixture();
    let finish!: (result: PluginRpcResponse) => void;
    f.invokeRuntime.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = f.invoke("invokeRuntime", { runtimeId: "p/write" });
    const guard = f.invokeRuntime.mock.lastCall?.[2] as
      (() => boolean) | undefined;
    f.retire();
    expect(guard?.()).toBe(false);
    finish({ status: "ok", result: "private" });
    expect(await pending).toMatchObject({ status: "unavailable" });
    expect(
      await f.invoke("submitAction", { kind: "say", text: "Late" }),
    ).toMatchObject({ status: "unavailable" });
    expect(f.actions.submitComposerAction).not.toHaveBeenCalled();
  });
  it("constructs public interaction/input context without private lanes", () => {
    const f = fixture();
    const result = buildSessionProjection({
      session: f.state.session!,
      executing: false,
      messages: [
        form,
        {
          ...form,
          id: "story",
          block: undefined,
          kind: "story",
          content: "Public story",
        },
      ],
      messageSeqs: createSessionMessageOrdinals()([
        form,
        { ...form, id: "story", block: undefined, kind: "story" },
      ]),
      submittedBlockIds: new Set(),
      streamingText: undefined,
      characters: [
        {
          id: "hero",
          name: "Hero",
          type: "player",
          fields: { publicLookingName: "credential-sentinel" },
          knowledge: "secret",
        },
      ],
      slots: [],
      actionKinds: f.state.sessionActionKinds,
      interactionHandle: f.handles.issue,
    });
    expect(result.messages[0]?.text).toBe("Public story");
    expect(result.input.seats[0]?.characterIds).toEqual(["hero"]);
    expect(result.input.kinds[0]?.label).toBe("Say");
    expect(result.pending[0]).toMatchObject({
      interaction: { title: "Public form", fields: [{ label: "Name" }] },
      handle: expect.any(String),
    });
    for (const secret of [
      "internal-block",
      "internal-turn",
      "internal-ref",
      "private-validator",
      "credential-sentinel",
      "knowledge",
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
  });
});

it("rechecks the current interaction after workspace or approval waits", async () => {
  const f = fixture();
  f.state.messages = [form];
  const handle = f.handles.issue(form)!;
  let finish!: (
    value: Awaited<ReturnType<SessionActions["submitInteraction"]>>,
  ) => void;
  f.actions.submitInteraction.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = f.invoke("submitInteraction", { handle, values: {} });
  const options = f.actions.submitInteraction.mock.lastCall?.[5];
  expect(options?.isCurrent?.()).toBe(true);
  f.state.messages = [];
  expect(options?.isCurrent?.()).toBe(false);
  finish({ rejected: [], status: "accepted" });
  await pending;
});

it("runs the mounted host adapter through real session actions, workspace and RPC approval boundaries", async () => {
  const f = fixture();
  f.state.gameState = {
    characters: [{ id: "hero", name: "Hero", type: "player" }],
  };
  const ds = {} as dataServices.DataService;
  const workspace: dataServices.SessionWorkspace = {
    run: (_id, _request, mutate) => mutate(),
    hydrate: async () => {},
    checkpoint: async () => {},
  };
  vi.spyOn(dataServices, "getSessionWorkspace").mockReturnValue(workspace);
  const rpc = vi.spyOn(api, "postPluginRpc").mockResolvedValue({
    status: "ok",
    runtimeResults: [
      {
        pluginId: "p",
        runtimeId: "p/write",
        status: "success",
        durationMs: 1,
        output: { providerContinuation: "credential-sentinel" },
      },
    ],
  });
  const send = vi
    .spyOn(api, "sendAction")
    .mockImplementation((_request, _event, _error, done) => {
      done?.();
      return new AbortController();
    });
  vi.spyOn(api, "getSession").mockResolvedValue(f.state.session!);
  let dispatch!: React.Dispatch<Parameters<typeof reducer>[1]>;
  function Wrapper({ children }: { children: ReactNode }) {
    const [state, update] = useReducer(reducer, f.state);
    dispatch = update;
    const refs = useSessionRuntimeRefs(state);
    const actions = useBuildSessionActions({
      state,
      dispatch: update,
      ds,
      workspace,
      refs,
      handleSseEvent: createSseEventHandler({ ...refs, dispatch: update, ds }),
    });
    return (
      <SessionStateContext value={state}>
        <SessionActionsContext value={actions}>
          {children}
        </SessionActionsContext>
      </SessionStateContext>
    );
  }
  const entry = {
    ...viewEntry,
    spec: {
      ...viewEntry.spec,
      capabilities: ["submitAction", "invokeRuntime"] as const,
    },
  };
  const hook = renderHook(
    () => useSessionBridgeActions(entry, "session", () => true),
    { wrapper: Wrapper },
  );
  await act(async () => {
    expect(
      await hook.result.current.handlers.submitAction!({
        kind: "say",
        text: "/literal player text",
      }),
    ).toEqual({ status: "accepted" });
  });
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    type: "submit_actions",
    payload: { actions: [{ kind: "say", text: "/literal player text" }] },
  });
  await act(async () => {
    expect(
      await hook.result.current.handlers.invokeRuntime!({
        runtimeId: "p/write",
        payload: { text: "Public" },
      }),
    ).toEqual({ status: "committed" });
  });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("session", {
    kind: "runtime",
    pluginId: "p",
    runtimeId: "p/write",
    payload: { text: "Public" },
  });
  expect(JSON.stringify(hook.result.current.projection)).not.toContain(
    "credential-sentinel",
  );
  act(() =>
    dispatch({
      type: "LOAD_SESSION_PLUGINS",
      plugins: [{ ...sessionPlugin, active: false }],
    }),
  );
  expect(hook.result.current.isCurrent()).toBe(false);
  expect(
    await hook.result.current.handlers.invokeRuntime!({ runtimeId: "p/write" }),
  ).toMatchObject({ status: "unavailable" });
  expect(rpc).toHaveBeenCalledTimes(1);
});
