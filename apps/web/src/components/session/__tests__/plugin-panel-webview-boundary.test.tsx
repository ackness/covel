import type { ComponentProps } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRpcResponse } from "@covel/shared";
import { PluginPanel } from "../plugin-panel.js";
import type { PluginWebview } from "../plugin-webview.js";

const mocks = vi.hoisted(() => ({
  webviewProps: undefined as ComponentProps<typeof PluginWebview> | undefined,
  postPluginRpc:
    vi.fn<(sessionId: string, req: unknown) => Promise<PluginRpcResponse>>(),
  toast: vi.fn(),
  namespaceData: {} as Record<string, Record<string, unknown>>,
  gameState: {
    characters: [
      {
        id: "char-1",
        name: "Alice",
        type: "player",
        fields: { secretBackstory: "CHARACTER-SECRET-SENTINEL" },
      },
    ] as unknown[],
    characterSchema: {
      types: ["player"],
      attributes: [
        {
          id: "secretTrait",
          name: "SCHEMA-SECRET-SENTINEL",
          type: "number",
          category: "trait",
        },
      ],
    } as Record<string, unknown>,
  },
}));

vi.mock("../plugin-webview.js", () => ({
  PluginWebview: (props: ComponentProps<typeof PluginWebview>) => {
    mocks.webviewProps = props;
    return <div data-testid="mock-webview" />;
  },
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      session: { id: "session-1" },
      gameState: mocks.gameState,
    },
  }),
  useSessionStructure: () => ({
    session: { id: "session-1" },
    gameState: mocks.gameState,
    world: null,
    sessionPlugins: [],
  }),
}));

vi.mock("@/stores/plugin-data-store.js", () => ({
  usePluginJobs: () => [],
  usePluginDataSessionId: () => "session-1",
  usePluginNamespaces: () => mocks.namespaceData,
  usePluginNamespace: (_pluginId: string, namespace: string) =>
    mocks.namespaceData[namespace] ?? {},
}));

vi.mock("@/lib/toast-channel.js", () => ({ emitToast: mocks.toast }));

vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  postPluginRpc: mocks.postPluginRpc,
}));

vi.mock("react-force-graph-2d", () => ({ default: () => null }));

beforeEach(() => {
  mocks.webviewProps = undefined;
  mocks.postPluginRpc.mockReset();
  mocks.toast.mockReset();
  mocks.namespaceData = {
    map: { current: "docks" },
    default: { note: "own-data" },
  };
});

afterEach(cleanup);

describe("non-session PluginWebview dataSource defense-in-depth", () => {
  it.each(["session.characters", "session.characterSchema"] as const)(
    "never injects %s into a non-session webview even if spec validation was bypassed",
    (source) => {
      render(
        <PluginPanel
          pluginId="untrusted-plugin"
          spec={{
            id: "peek",
            label: "Peek",
            dataSource: { source },
            webview: { html: "<p>probe</p>" },
          }}
        />,
      );
      expect(mocks.webviewProps).toBeDefined();
      expect(mocks.webviewProps?.state.data).toEqual({});
      const serialized = JSON.stringify(mocks.webviewProps?.state);
      expect(serialized).not.toContain("CHARACTER-SECRET-SENTINEL");
      expect(serialized).not.toContain("SCHEMA-SECRET-SENTINEL");
      expect(serialized).not.toContain("Alice");
    },
  );

  it("also blocks session character sources in snapshot mode for non-session webviews", () => {
    render(
      <PluginPanel
        pluginId="untrusted-plugin"
        stateOverride={{ secret: "CHARACTER-SECRET-SENTINEL" }}
        spec={{
          id: "peek-snapshot",
          label: "Peek snapshot",
          dataSource: { source: "session.characters" },
          webview: { html: "<p>probe</p>" },
        }}
      />,
    );
    expect(mocks.webviewProps?.state.data).toEqual({});
    expect(JSON.stringify(mocks.webviewProps?.state)).not.toContain(
      "CHARACTER-SECRET-SENTINEL",
    );
  });

  it("still delivers the plugin's own namespace data to a non-session webview", () => {
    render(
      <PluginPanel
        pluginId="map-plugin"
        spec={{
          id: "map",
          label: "Map",
          dataSource: { namespace: "map" },
          webview: { html: "<p>map</p>" },
        }}
      />,
    );
    expect(mocks.webviewProps?.state.data).toEqual({ current: "docks" });
  });
});

describe("non-session PluginWebview RPC outcome sanitization", () => {
  const webviewSpec = {
    id: "widget",
    label: "Widget",
    webview: { html: "<p>widget</p>" },
  };
  const invoke = async (name: string, params: Record<string, unknown>) => {
    let result: unknown;
    await act(async () => {
      result = await mocks.webviewProps!.handlers[name]!(params);
    });
    return result;
  };

  it("returns bounded sanitized target output for invokeRuntime and hides internal and cross-plugin fields", async () => {
    mocks.postPluginRpc.mockResolvedValueOnce({
      status: "ok",
      turnId: "turn-uuid-secret",
      durationMs: 42,
      deferredJobs: [{ jobId: "job-secret", runtimeId: "other-plugin/bg" }],
      runtimeResults: [
        {
          runtimeId: "other-plugin/secret",
          pluginId: "other-plugin",
          status: "success",
          durationMs: 3,
          output: { secret: "OTHER-PLUGIN-SECRET" },
        },
        {
          runtimeId: "owner/run",
          pluginId: "owner",
          status: "success",
          durationMs: 1,
          output: {
            value: "fixture output",
            _hidden: "HIDDEN-SECRET",
            turnId: "nested-turn-secret",
            stack: "Error\n at /srv/secret.ts:1",
          },
        },
      ],
    });

    render(<PluginPanel pluginId="owner" spec={webviewSpec} />);
    const outcome = await invoke("invokeRuntime", {
      runtimeId: "owner/run",
      payload: { value: "in" },
    });

    expect(outcome).toEqual({
      ok: true,
      status: "ok",
      data: { value: "fixture output" },
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("turn-uuid-secret");
    expect(serialized).not.toContain("job-secret");
    expect(serialized).not.toContain("OTHER-PLUGIN-SECRET");
    expect(serialized).not.toContain("HIDDEN-SECRET");
    expect(serialized).not.toContain("/srv/secret.ts");
  });

  it("returns failed status without leaking raw error text or abortReason when invokeRuntime fails", async () => {
    mocks.postPluginRpc.mockResolvedValueOnce({
      status: "ok",
      turnId: "turn-uuid-secret",
      abortReason: "401 Bearer sk-abort-secret",
      runtimeResults: [
        {
          runtimeId: "owner/run",
          pluginId: "owner",
          status: "failed",
          durationMs: 1,
          error: "401 Bearer sk-runtime-secret\n at /srv/internal.ts:99",
          output: { leaked: "FAILURE-OUTPUT-SECRET" },
        },
      ],
    });

    render(<PluginPanel pluginId="owner" spec={webviewSpec} />);
    const outcome = await invoke("invokeRuntime", {
      runtimeId: "owner/run",
    });

    expect(outcome).toEqual({ ok: false, status: "failed" });
    expect(JSON.stringify(outcome)).not.toMatch(/sk-|FAILURE-OUTPUT|internal/);
  });

  it("omits oversized runtime output while preserving ok outcome", async () => {
    mocks.postPluginRpc.mockResolvedValueOnce({
      status: "ok",
      runtimeResults: [
        {
          runtimeId: "owner/run",
          pluginId: "owner",
          status: "success",
          durationMs: 1,
          output: { huge: "x".repeat(40_000) },
        },
      ],
    });

    render(<PluginPanel pluginId="owner" spec={webviewSpec} />);
    const outcome = await invoke("invokeRuntime", {
      runtimeId: "owner/run",
    });

    expect(outcome).toEqual({ ok: true, status: "ok" });
  });

  it("strips environment, eventId, deferredJobs, and hidden keys across invokePluginAction, invokeCommand, and emitEvent", async () => {
    mocks.postPluginRpc
      .mockResolvedValueOnce({
        status: "ok",
        result: { count: 3, _secret: "ACTION-SECRET", apiKey: "sk-123" },
        environment: {
          capturedAt: "2026-01-01T00:00:00Z",
          session: { id: "ENV-SESSION-SECRET", status: "active" },
        },
      })
      .mockResolvedValueOnce({
        status: "ok",
        result: {
          ok: true,
          rolls: [18],
          clientAction: { type: "open-plugin-panel", panelId: "dice" },
          _internal: "CMD-SECRET",
        },
        environment: {
          capturedAt: "2026-01-01T00:00:00Z",
          session: { id: "ENV-CMD-SECRET", status: "active" },
        },
      })
      .mockResolvedValueOnce({
        status: "ok",
        eventId: "EVENT-ID-SECRET",
        topic: "owner.clicked",
        deferredJobs: [{ jobId: "JOB-SECRET", runtimeId: "other/subscriber" }],
      });

    render(<PluginPanel pluginId="owner" spec={webviewSpec} />);

    const actionOutcome = await invoke("invokePluginAction", {
      action: "query",
    });
    expect(actionOutcome).toEqual({
      ok: true,
      status: "ok",
      data: { count: 3 },
    });
    expect(JSON.stringify(actionOutcome)).not.toMatch(/SECRET|sk-123/);

    const commandOutcome = await invoke("invokeCommand", {
      command: "roll",
      args: { sides: 20 },
    });
    expect(commandOutcome).toEqual({
      ok: true,
      status: "ok",
      data: { ok: true, rolls: [18] },
    });
    expect(JSON.stringify(commandOutcome)).not.toMatch(/SECRET|clientAction/);

    const eventOutcome = await invoke("emitEvent", {
      topic: "owner.clicked",
      data: { id: "docks" },
    });
    expect(eventOutcome).toEqual({ ok: true, status: "ok" });
    expect(JSON.stringify(eventOutcome)).not.toMatch(
      /EVENT-ID-SECRET|JOB-SECRET|other\/subscriber/,
    );
  });
});

describe("non-session PluginWebview explicitHandlers boundary", () => {
  const webviewSpec = {
    id: "widget",
    label: "Widget",
    webview: { html: "<p>widget</p>" },
  };

  it("never forwards arbitrary host handlers, non-stage sendMessage, or RPC overrides to a non-session webview", () => {
    const arbitrary = vi.fn();
    const sendMessage = vi.fn();
    const draftMessage = vi.fn();
    const overrideRpc = vi.fn();

    render(
      <PluginPanel
        pluginId="owner"
        spec={webviewSpec}
        handlers={{
          arbitraryHostAction: arbitrary,
          deleteSession: arbitrary,
          sendMessage,
          draftMessage,
          invokeRuntime: overrideRpc,
        }}
      />,
    );

    const exposed = mocks.webviewProps!.handlers;
    expect(exposed).not.toHaveProperty("arbitraryHostAction");
    expect(exposed).not.toHaveProperty("deleteSession");
    expect(exposed).not.toHaveProperty("sendMessage");
    expect(exposed.invokeRuntime).not.toBe(overrideRpc);
    expect(exposed).toHaveProperty("draftMessage");
  });

  it("blocks both sendMessage and draftMessage on snapshot message-block webviews", () => {
    const sendMessage = vi.fn();
    const draftMessage = vi.fn();

    render(
      <PluginPanel
        pluginId="owner"
        spec={webviewSpec}
        stateOverride={{ card: "hello" }}
        handlers={{ sendMessage, draftMessage }}
      />,
    );

    const exposed = mocks.webviewProps!.handlers;
    expect(exposed).not.toHaveProperty("sendMessage");
    expect(exposed).not.toHaveProperty("draftMessage");
  });

  it("allows documented right-panel draftMessage and stage sendMessage only with validated bounded params", async () => {
    const draftMessage = vi.fn();
    const stageSendMessage = vi.fn();

    const view = render(
      <PluginPanel
        pluginId="owner"
        spec={webviewSpec}
        handlers={{ draftMessage }}
      />,
    );

    expect(
      await mocks.webviewProps!.handlers.draftMessage!({
        text: "  Go to the docks  ",
        selectionGroup: "map:move",
      }),
    ).toEqual({ status: "ok" });
    expect(draftMessage).toHaveBeenCalledExactlyOnceWith({
      text: "Go to the docks",
      selectionGroup: "map:move",
    });

    await expect(
      Promise.resolve().then(() =>
        mocks.webviewProps!.handlers.draftMessage!({
          text: "x".repeat(4001),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() =>
        mocks.webviewProps!.handlers.draftMessage!({
          text: "ok",
          extra: "forbidden",
        }),
      ),
    ).rejects.toThrow();

    view.rerender(
      <PluginPanel
        pluginId="owner"
        spec={webviewSpec}
        surfaceContext={{
          surface: "stage",
          turnId: "t1",
          turnIds: ["t1"],
          choices: [],
        }}
        handlers={{ sendMessage: stageSendMessage, draftMessage }}
      />,
    );

    expect(mocks.webviewProps!.handlers).toHaveProperty("sendMessage");
    expect(mocks.webviewProps!.handlers).not.toHaveProperty("draftMessage");
    expect(
      await mocks.webviewProps!.handlers.sendMessage!({ text: "  Explore  " }),
    ).toEqual({ status: "ok" });
    expect(stageSendMessage).toHaveBeenCalledExactlyOnceWith({
      text: "Explore",
    });
    await expect(
      Promise.resolve().then(() =>
        mocks.webviewProps!.handlers.sendMessage!({ text: "x".repeat(4001) }),
      ),
    ).rejects.toThrow();
  });
});
