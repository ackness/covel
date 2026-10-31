// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { PluginRpcResponse, SseEnvelope } from "@covel/shared";
import * as credentials from "@/services/session-credentials.js";
import * as dataServices from "@/services/data-service.js";
import { sendAction, abortTurn } from "@/services/api/actions.js";
import { runActionStream } from "@/stores/session-store/runtime-rpc.js";
import { createSessionWorkspace } from "@/services/data-service/workspace.js";
import type { SessionWorkspaceOperations } from "@/services/data-service/types.js";
import {
  postPluginRpcWithApproval,
  resolvePluginRpcApprovalResponse,
} from "../plugin-rpc-ui.js";

vi.mock("@/services/subscription.js", () => ({
  pauseSessionSubscriptions: () => vi.fn(),
}));
vi.mock("@/lib/approval-message.js", () => ({
  confirmPluginApproval: async () => true,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delayedCredentials() {
  const gate = deferred<Record<string, string>>();
  const read = vi
    .spyOn(credentials, "sessionAuthHeaders")
    .mockReturnValue(gate.promise);
  return {
    read,
    release: () => gate.resolve({ "X-Session-Token": "credential-sentinel" }),
  };
}

const action = {
  requestId: "request",
  sessionId: "session",
  type: "submit_actions",
  payload: { actions: [{ kind: "say", text: "Public input" }] },
} as const;
const approval = {
  status: "approval-required",
  approvalId: "approval",
  pending: { sessionId: "session", pluginId: "owner", action: "write" },
} as const;
const completed: PluginRpcResponse = { status: "ok", result: true };

it.each([false, true])(
  "rechecks the runtime lease after credentials (retired: %s)",
  async (retired) => {
    let current = true;
    const headers = delayedCredentials();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(completed),
    );
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(dataServices, "getSessionWorkspace").mockReturnValue({
      run: (_session, _request, mutate) => mutate(),
      hydrate: async () => {},
      checkpoint: async () => {},
    });
    const pending = postPluginRpcWithApproval({
      sessionId: "session",
      pluginId: "owner",
      actionLabel: "write",
      request: { kind: "runtime", pluginId: "owner", runtimeId: "owner/write" },
      confirm: async () => true,
      t: (key) => key,
      isCurrent: () => current,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(headers.read).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
    current = !retired;
    headers.release();
    if (retired) {
      expect(await pending).toBeInstanceOf(Error);
      expect(fetch).not.toHaveBeenCalled();
    } else {
      expect(await pending).toEqual(completed);
      expect(fetch).toHaveBeenCalledOnce();
      const init = fetch.mock.calls[0]?.[1] as RequestInit;
      expect(new Headers(init.headers).get("X-Session-Token")).toBe(
        "credential-sentinel",
      );
      expect(init).not.toHaveProperty("canDispatch");
    }
  },
);

it.each([
  { label: "player action", request: action, retired: false },
  { label: "player action", request: action, retired: true },
  ...[false, true].map((retired) => ({
    label: "interaction answer",
    retired,
    request: {
      ...action,
      payload: {
        actions: [
          {
            kind: "act",
            interaction: {
              turnId: "turn",
              interactionId: "form",
              type: "form" as const,
            },
            fields: { route: "Left" },
          },
        ],
      },
    },
  })),
])(
  "rechecks the $label lease after credentials (retired: $retired)",
  async ({ request, retired }) => {
    let current = true;
    const headers = delayedCredentials();
    const fetch = vi.fn(async () => new Response(""));
    vi.stubGlobal("fetch", fetch);
    const done = vi.fn();
    const error = vi.fn();
    sendAction(request, vi.fn(), error, done, undefined, () => current);
    await vi.waitFor(() => expect(headers.read).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
    current = !retired;
    headers.release();
    await vi.waitFor(() =>
      expect(retired ? error : done).toHaveBeenCalledOnce(),
    );
    expect(fetch).toHaveBeenCalledTimes(retired ? 0 : 1);
    expect(retired ? done : error).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "rechecks RPC approval authority after credentials (retired: %s)",
  async (retired) => {
    let current = true;
    const headers = delayedCredentials();
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    const retry = vi.fn(async () => completed);
    const pending = resolvePluginRpcApprovalResponse({
      response: approval,
      sessionId: "session",
      pluginId: "owner",
      actionLabel: "write",
      confirm: async () => true,
      retry,
      t: (key) => key,
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(headers.read).toHaveBeenCalledOnce());
    current = !retired;
    headers.release();
    expect(await pending).toEqual(retired ? null : completed);
    expect(fetch).toHaveBeenCalledTimes(retired ? 0 : 1);
    expect(retry).toHaveBeenCalledTimes(retired ? 0 : 1);
  },
);

it("blocks a player action approval grant retired during credential lookup", async () => {
  let current = true;
  const headers = delayedCredentials();
  headers.read.mockResolvedValueOnce({});
  const fetch = vi.fn(async () => Response.json(approval, { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  const pending = runActionStream(action, vi.fn(), vi.fn(), {
    canDispatch: () => current,
  }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(headers.read).toHaveBeenCalledTimes(2));
  current = false;
  headers.release();
  expect(await pending).toBeInstanceOf(Error);
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not dispatch a bridge abort retired during credential lookup", async () => {
  let current = true;
  const headers = delayedCredentials();
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  const pending = abortTurn("session", () => current).catch(
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(headers.read).toHaveBeenCalledOnce());
  current = false;
  headers.release();
  expect(await pending).toBeInstanceOf(Error);
  expect(fetch).not.toHaveBeenCalled();
});

it("settles a dispatched player action after its bridge lease retires", async () => {
  let current = true;
  vi.spyOn(credentials, "sessionAuthHeaders").mockResolvedValue({});
  const response = deferred<Response>();
  const fetch = vi.fn(() => response.promise);
  vi.stubGlobal("fetch", fetch);
  const done = vi.fn();
  const error = vi.fn();
  const onEvent = vi.fn();
  sendAction(action, onEvent, error, done, undefined, () => current);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  current = false;
  const event = {
    type: "execution.completed",
    sessionId: "session",
    turnId: "turn",
    requestId: "request",
    traceId: "trace",
    flowId: "flow",
    seq: 1,
    timestamp: "2026-10-31T00:00:00Z",
    payload: { committed: true },
  } satisfies SseEnvelope;
  response.resolve(new Response(`data: ${JSON.stringify(event)}\n\n`));
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(onEvent).toHaveBeenCalledWith(event);
  expect(error).not.toHaveBeenCalled();
});

it("checkpoints a dispatched runtime after its bridge lease retires", async () => {
  let current = true;
  vi.spyOn(credentials, "sessionAuthHeaders").mockResolvedValue({});
  const response = deferred<Response>();
  const fetch = vi.fn(() => response.promise);
  vi.stubGlobal("fetch", fetch);
  const commit = vi.fn(async () => {});
  const service = {
    withSessionWorkspace: <T>(
      _session: string,
      operation: (workspace: SessionWorkspaceOperations) => Promise<T>,
    ) =>
      operation({
        persistInput: vi.fn(),
        hydrate: vi.fn(),
        stage: vi.fn(),
        commit,
      }),
  } satisfies Pick<dataServices.DataService, "withSessionWorkspace">;
  const workspace = createSessionWorkspace(
    service as dataServices.DataService,
    "local",
  );
  vi.spyOn(dataServices, "getSessionWorkspace").mockReturnValue(workspace);
  const pending = postPluginRpcWithApproval({
    sessionId: "session",
    pluginId: "owner",
    actionLabel: "write",
    request: { kind: "runtime", pluginId: "owner", runtimeId: "owner/write" },
    confirm: async () => true,
    t: (key) => key,
    isCurrent: () => current,
  });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  current = false;
  response.resolve(Response.json(completed));
  expect(await pending).toEqual(completed);
  expect(commit).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^plugin-rpc:/),
  );
});
