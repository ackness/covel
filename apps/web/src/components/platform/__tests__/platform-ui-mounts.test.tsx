import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import type { ConfigFlowRunSnapshot } from "@covel/shared/platform";
import {
  closeCommandPalette,
  closePluginConfigFlow,
  openCommandPalette,
  openPluginConfigFlow,
  openPluginWindow,
  resetPlatformUiState,
  usePlatformUiState,
} from "@/lib/platform-ui-events.js";
import { ConfigFlowDialog } from "../config-flow-dialog.js";
import { TopbarStatusBadges } from "../topbar-status-badges.js";
import { CommandPalette } from "../command-palette.js";
import { PluginSettingsSectionPane } from "../plugin-settings-sections.js";
import { FloatingWindowHost } from "../floating-window-host.js";
import { ComposerActionButtons } from "@/components/session/game-view/composer-action-buttons.js";

const mocks = vi.hoisted(() => ({
  startPluginConfigFlow: vi.fn(),
  getPluginConfigFlowRun: vi.fn(),
  stepPluginConfigFlow: vi.fn(),
  cancelPluginConfigFlow: vi.fn(),
  invokePluginAppAction: vi.fn(),
  fetchPluginInstanceData: vi.fn(),
  openExternalUrl: vi.fn(async () => true),
  toast: vi.fn(),
}));

vi.mock("@/lib/desktop-bridge.js", () => ({
  openExternalUrl: mocks.openExternalUrl,
  isDesktopApp: () => false,
}));

vi.mock("@/lib/toast-channel.js", () => ({
  emitToast: mocks.toast,
}));

vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  startPluginConfigFlow: mocks.startPluginConfigFlow,
  getPluginConfigFlowRun: mocks.getPluginConfigFlowRun,
  stepPluginConfigFlow: mocks.stepPluginConfigFlow,
  cancelPluginConfigFlow: mocks.cancelPluginConfigFlow,
  invokePluginAppAction: mocks.invokePluginAppAction,
  fetchPluginInstanceData: mocks.fetchPluginInstanceData,
}));

vi.mock("@/components/session/plugin-panel.js", () => ({
  PluginPanel: (props: {
    pluginId: string;
    panelId?: string;
    stateOverride?: Record<string, unknown>;
    handlers?: Record<
      string,
      (params: Record<string, unknown>) => Promise<unknown>
    >;
  }) => (
    <div
      data-testid={`mock-panel-${props.pluginId}-${props.panelId ?? "default"}`}
    >
      <span data-testid="panel-state">
        {JSON.stringify(props.stateOverride ?? {})}
      </span>
      <button
        type="button"
        onClick={() =>
          void props.handlers?.appAction?.({
            action: "sync-now",
            input: { force: true },
          })
        }
      >
        Trigger App Action
      </button>
    </div>
  ),
}));

function makeSnapshot(
  step: ConfigFlowRunSnapshot["step"],
  status: ConfigFlowRunSnapshot["status"] = "active",
): ConfigFlowRunSnapshot {
  const now = new Date().toISOString();
  return {
    runId: "run-1",
    pluginId: "demo-platform",
    flowId: "connect",
    status,
    step,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function FlowObserver({
  onChange,
}: {
  onChange: (snap: ReturnType<typeof usePlatformUiState>) => void;
}) {
  const state = usePlatformUiState();
  onChange(state);
  return null;
}

describe("Platform v2 Web UI mounts", () => {
  beforeEach(async () => {
    resetPlatformUiState();
    vi.clearAllMocks();
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("opens a config flow from the composer and cancels a start that returns after dismissal", async () => {
    type StartResult = {
      ok: true;
      run: ConfigFlowRunSnapshot;
    };
    let resolveStart!: (result: StartResult) => void;
    const pending = new Promise<StartResult>((resolve) => {
      resolveStart = resolve;
    });
    mocks.startPluginConfigFlow.mockReturnValueOnce(pending);
    mocks.cancelPluginConfigFlow.mockResolvedValueOnce({ ok: true });
    render(
      <>
        <ComposerActionButtons
          sessionId="session-1"
          entries={[
            {
              pluginId: "demo-platform",
              specs: [
                {
                  id: "connect",
                  label: "Connect account",
                  openFlow: "connect",
                },
              ],
            },
          ]}
          disabled={false}
          locale="en-US"
          t={i18n.t}
        />
        <ConfigFlowDialog />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    await waitFor(() =>
      expect(mocks.startPluginConfigFlow).toHaveBeenCalledOnce(),
    );
    act(() => closePluginConfigFlow());
    await act(async () => {
      resolveStart({
        ok: true,
        run: makeSnapshot({
          kind: "form",
          stepId: "connect",
          title: "Connect",
          fields: [],
        }),
      });
    });
    expect(mocks.cancelPluginConfigFlow).toHaveBeenCalledWith(
      "demo-platform",
      "connect",
      "run-1",
    );
  });

  it("drives ConfigFlowDialog across form, browser externalAuth + poll, confirm, import maxBytes, and done", async () => {
    let latestState = usePlatformUiState;
    void latestState;
    const versions: number[] = [];

    mocks.startPluginConfigFlow.mockResolvedValueOnce({
      ok: true,
      run: makeSnapshot({
        kind: "form",
        stepId: "s-form",
        title: "Enter Endpoint",
        fields: [
          {
            name: "endpoint",
            label: "Endpoint URL",
            type: "url",
            required: true,
            defaultValue: "https://api.example",
          },
          {
            name: "remember",
            label: "Remember",
            type: "boolean",
            defaultValue: true,
          },
        ],
      }),
    });

    mocks.stepPluginConfigFlow
      .mockResolvedValueOnce({
        ok: true,
        run: makeSnapshot({
          kind: "browser",
          stepId: "s-oauth",
          title: "Authorize Account",
          authorizeUrl: "https://auth.example/start",
          completion: "loopback-or-paste",
          callbackUrl: "http://127.0.0.1:4321/cb",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        run: makeSnapshot({
          kind: "import",
          stepId: "s-import",
          title: "Upload JSON",
          maxBytes: 10,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        run: makeSnapshot({
          kind: "confirm",
          stepId: "s-confirm",
          title: "Confirm Save",
          details: [{ label: "Mode", value: "import" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        run: makeSnapshot(
          {
            kind: "done",
            title: "All Connected",
            summary: { Account: "alice" },
          },
          "completed",
        ),
      });

    render(
      <>
        <FlowObserver onChange={(s) => versions.push(s.instanceDataVersion)} />
        <ConfigFlowDialog />
      </>,
    );

    act(() => {
      openPluginConfigFlow("demo-platform", "connect");
    });

    await screen.findByText("Enter Endpoint");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText("Authorize Account");
    expect(mocks.stepPluginConfigFlow).toHaveBeenNthCalledWith(
      1,
      "demo-platform",
      "connect",
      "run-1",
      {
        stepId: "s-form",
        data: { endpoint: "https://api.example", remember: true },
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Open authorization page/i }),
    );
    await waitFor(() =>
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        "https://auth.example/start",
      ),
    );

    // Paste callback URL to advance to import step
    const cbInput = screen.getByPlaceholderText("http://127.0.0.1:4321/cb");
    fireEvent.change(cbInput, {
      target: { value: "http://127.0.0.1:4321/cb?code=123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText("Upload JSON");
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, {
      target: { value: "oversized-payload-exceeds-10-bytes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText(/exceeds 10 bytes/i);

    fireEvent.change(textarea, { target: { value: '{"ok":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await screen.findByText("Confirm Save");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await screen.findByText("All Connected");
    expect(screen.getByText("alice")).toBeTruthy();
    expect(Math.max(...versions)).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    await waitFor(() => {
      expect(screen.queryByText("All Connected")).toBeNull();
    });
  });

  it("polls device ConfigFlowDialog step via openExternalUrl until done", async () => {
    mocks.startPluginConfigFlow.mockResolvedValueOnce({
      ok: true,
      run: makeSnapshot({
        kind: "device",
        stepId: "s-dev",
        title: "Device Verification",
        userCode: "CODE-99",
        verificationUri: "https://device.example/verify",
        intervalSec: 1,
      }),
    });
    mocks.getPluginConfigFlowRun.mockResolvedValueOnce({
      ok: true,
      run: makeSnapshot(
        { kind: "done", title: "Device Authorized" },
        "completed",
      ),
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ConfigFlowDialog />);

    act(() => {
      openPluginConfigFlow("demo-platform", "connect");
    });

    await waitFor(() => {
      expect(screen.getByText("CODE-99")).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Open verification page/i }),
    );
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      "https://device.example/verify",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    await waitFor(() => {
      expect(screen.getByText("Device Authorized")).toBeTruthy();
    });
  });

  it("renders TopbarStatusBadges, triggers appAction, and opens returned flow", async () => {
    mocks.fetchPluginInstanceData.mockResolvedValueOnce({
      ok: true,
      entries: [
        {
          key: "status",
          value: { tone: "ok", text: "Synced 2/2" },
          updatedAt: "now",
        },
      ],
    });
    mocks.invokePluginAppAction.mockResolvedValueOnce({
      ok: true,
      result: { openFlow: "reauth" },
    });

    let activeFlow: unknown = null;
    render(
      <>
        <FlowObserver onChange={(s) => (activeFlow = s.activeConfigFlow)} />
        <TopbarStatusBadges
          entries={[
            {
              pluginId: "demo-platform",
              specs: [
                {
                  id: "sync-pill",
                  label: "Sync Status",
                  statusAction: "handle-click",
                  dataSource: {
                    source: "instance.data",
                    namespace: "health",
                    key: "status",
                  },
                  defaultStatus: { tone: "idle", text: "Idle" },
                },
              ],
            },
          ]}
        />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByText("Synced 2/2")).toBeTruthy();
    });
    fireEvent.click(
      screen.getByTestId("topbar-status-demo-platform-sync-pill"),
    );
    await waitFor(() => {
      expect(mocks.invokePluginAppAction).toHaveBeenCalledWith(
        "demo-platform",
        "handle-click",
        { trigger: "click" },
      );
      expect(activeFlow).toMatchObject({
        pluginId: "demo-platform",
        flowId: "reauth",
      });
    });
  });

  it("filters CommandPalette commands and executes appAction & flow launches", async () => {
    mocks.invokePluginAppAction.mockResolvedValueOnce({
      ok: true,
      result: { message: "Refreshed!" },
    });

    let capturedFlow: unknown = null;
    render(
      <>
        <FlowObserver onChange={(s) => (capturedFlow = s.activeConfigFlow)} />
        <CommandPalette
          appCommands={[
            {
              id: "demo-platform:refresh",
              pluginId: "demo-platform",
              source: "plugin",
              sourceLabel: "Demo",
              name: "refresh-accounts",
              description: "Refresh all accounts",
              scope: "instance",
              palette: true,
              appAction: "refresh",
            },
            {
              id: "demo-platform:login",
              pluginId: "demo-platform",
              source: "plugin",
              sourceLabel: "Demo",
              name: "connect-account",
              description: "Launch login flow",
              scope: "instance",
              palette: true,
              openFlow: "login-flow",
            },
          ]}
        />
      </>,
    );

    act(() => openCommandPalette());
    const search = screen.getByPlaceholderText(/Type a command/i);
    fireEvent.change(search, { target: { value: "refresh" } });

    expect(screen.getByText("/refresh-accounts")).toBeTruthy();
    expect(screen.queryByText("/connect-account")).toBeNull();

    fireEvent.click(screen.getByText("/refresh-accounts"));
    await waitFor(() => {
      expect(mocks.invokePluginAppAction).toHaveBeenCalledWith(
        "demo-platform",
        "refresh",
        {},
      );
    });

    act(() => openCommandPalette());
    fireEvent.click(screen.getByText("/connect-account"));
    expect(capturedFlow).toMatchObject({
      pluginId: "demo-platform",
      flowId: "login-flow",
    });
    act(() => closeCommandPalette());
  });

  it("enforces webview refusal in PluginSettingsSectionPane and invokes appAction handlers", async () => {
    mocks.fetchPluginInstanceData.mockResolvedValue({
      ok: true,
      entries: [{ key: "profile", value: { name: "alice" }, updatedAt: "now" }],
    });
    mocks.invokePluginAppAction.mockResolvedValue({ ok: true, result: {} });

    const { rerender } = render(
      <PluginSettingsSectionPane
        section={{
          pluginId: "demo-platform",
          spec: {
            id: "accounts",
            label: "Accounts",
            sectionGroup: "plugins",
            dataSource: { source: "instance.data", namespace: "accounts" },
            view: { component: "Stack", children: [] },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("panel-state").textContent).toContain("alice");
    });

    fireEvent.click(screen.getByRole("button", { name: "Trigger App Action" }));
    await waitFor(() => {
      expect(mocks.invokePluginAppAction).toHaveBeenCalledWith(
        "demo-platform",
        "sync-now",
        { force: true },
      );
    });

    rerender(
      <PluginSettingsSectionPane
        section={{
          pluginId: "demo-platform",
          spec: {
            id: "illegal-wv",
            label: "Bad",
            sectionGroup: "plugins",
            webview: { html: "<h1>blocked</h1>" },
          },
        }}
      />,
    );
    expect(
      screen.getByText("Webviews are not permitted in this slot."),
    ).toBeTruthy();
  });

  it("renders FloatingWindowHost filtered strictly by instance vs session scope", () => {
    const entries = [
      {
        pluginId: "demo-platform",
        specs: [
          {
            id: "inst-win",
            label: "Instance Utility",
            windowScope: "instance" as const,
            view: { component: "Stack", children: [] },
          },
          {
            id: "sess-win",
            label: "Session Utility",
            windowScope: "session" as const,
            view: { component: "Stack", children: [] },
          },
        ],
      },
    ];

    render(
      <>
        <FloatingWindowHost scope="instance" entries={entries} />
        <FloatingWindowHost scope="session" entries={entries} />
      </>,
    );

    act(() => {
      openPluginWindow("demo-platform", "inst-win");
      openPluginWindow("demo-platform", "sess-win");
    });

    expect(
      screen.getByTestId("floating-window-demo-platform:inst-win"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("floating-window-demo-platform:sess-win"),
    ).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(
      screen.queryByTestId("floating-window-demo-platform:inst-win"),
    ).toBeNull();
    expect(
      screen.getByTestId("floating-window-demo-platform:sess-win"),
    ).toBeTruthy();
  });
});
