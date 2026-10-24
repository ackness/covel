import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { getDesktopInfo } from "@/lib/desktop-bridge.js";
import { DesktopPane } from "../DesktopPane.js";

const bridgeMocks = vi.hoisted(() => ({
  getDesktopProxyConfig: vi.fn(),
  setDesktopProxyConfig: vi.fn(),
  resetOnboarding: vi.fn(),
  hasElectronIpc: vi.fn(),
  reloadServerAndWait: vi.fn(),
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { llmConfig: { configured: true } } }),
}));

vi.mock("@/components/onboarding-wizard.js", () => ({
  resetOnboarding: bridgeMocks.resetOnboarding,
}));

vi.mock("@/lib/desktop-bridge.js", () => ({
  hasElectronIpc: bridgeMocks.hasElectronIpc,
  isDesktopApp: () => true,
  getDesktopInfo: vi.fn().mockResolvedValue(null),
  getDesktopProxyConfig: bridgeMocks.getDesktopProxyConfig,
  setDesktopProxyConfig: bridgeMocks.setDesktopProxyConfig,
  openLogsDir: vi.fn(),
  openConfigDir: vi.fn(),
  openDataDir: vi.fn(),
  openLlmToml: vi.fn().mockResolvedValue({ created: false }),
  openKeysEnv: vi.fn().mockResolvedValue(undefined),
  pickDataDir: vi.fn().mockResolvedValue(null),
  reloadServerAndWait: bridgeMocks.reloadServerAndWait,
}));

const desktopInfoFixture = {
  version: "test",
  platform: "darwin",
  isDev: false,
  covelHome: "/home",
  dataRoot: "/data",
  logsDir: "/logs",
  dbPath: "/data/covel.db",
  configTomlPath: "/home/config.toml",
  llmTomlPath: "/home/llm.toml",
  keysEnvPath: "/home/keys.env",
  serverPort: 9479,
};

describe("DesktopPane proxy loading", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    bridgeMocks.getDesktopProxyConfig.mockReset();
    bridgeMocks.setDesktopProxyConfig.mockReset();
    bridgeMocks.resetOnboarding.mockReset().mockResolvedValue(undefined);
    bridgeMocks.hasElectronIpc.mockReset().mockReturnValue(false);
    bridgeMocks.reloadServerAndWait.mockReset().mockResolvedValue(true);
    vi.mocked(getDesktopInfo).mockReset().mockResolvedValue(null);
  });

  it("explains why an externally managed development server cannot restart", async () => {
    bridgeMocks.hasElectronIpc.mockReturnValue(true);
    vi.mocked(getDesktopInfo).mockResolvedValue({
      ...desktopInfoFixture,
      isDev: true,
    });
    render(<DesktopPane />);
    const restart = screen.getByRole("button", {
      name: i18n.t("settings.desktopApplyConfigChanges"),
    });
    expect((restart as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText(i18n.t("settings.desktopRestartDevHint"));
    fireEvent.click(restart);
    expect(bridgeMocks.reloadServerAndWait).not.toHaveBeenCalled();
  });

  it("keeps packaged sidecar restart available after loading desktop info", async () => {
    bridgeMocks.hasElectronIpc.mockReturnValue(true);
    vi.mocked(getDesktopInfo).mockResolvedValue(desktopInfoFixture);
    render(<DesktopPane />);
    const restart = screen.getByRole("button", {
      name: i18n.t("settings.desktopApplyConfigChanges"),
    });
    expect((restart as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() =>
      expect((restart as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(restart);
    expect(bridgeMocks.reloadServerAndWait).toHaveBeenCalledTimes(1);
  });

  it("reports an onboarding reset only after persistence and handles failures", async () => {
    bridgeMocks.getDesktopProxyConfig.mockResolvedValue({
      mode: "direct",
      effective: "direct",
      systemAvailable: false,
    });
    let rejectReset!: (error: Error) => void;
    const reset = new Promise<void>((_resolve, reject) => {
      rejectReset = reject;
    });
    bridgeMocks.resetOnboarding.mockReturnValueOnce(reset);
    render(<DesktopPane />);
    const button = screen.getByRole("button", {
      name: i18n.t("settings.desktopResetOnboarding"),
    });
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.queryByText(i18n.t("settings.desktopOnboardingResetToast")),
    ).toBeNull();
    await act(async () => rejectReset(new Error("storage unavailable")));
    expect(screen.getByRole("alert").textContent).toBe(
      i18n.t("settings.saveFailed"),
    );
    expect(
      screen.queryByText(i18n.t("settings.desktopOnboardingResetToast")),
    ).toBeNull();
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole("status").textContent).toBe(
      i18n.t("settings.desktopOnboardingResetToast"),
    );
    expect(bridgeMocks.resetOnboarding).toHaveBeenCalledTimes(2);
  });

  it("keeps proxy editing disabled until the persisted config is loaded", async () => {
    let resolveLoad:
      | ((value: {
          mode: "http";
          url: string;
          effective: "proxy";
          systemAvailable: boolean;
        }) => void)
      | undefined;
    bridgeMocks.getDesktopProxyConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );

    render(<DesktopPane />);
    const save = screen.getByRole("button", { name: "Save and apply" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(bridgeMocks.setDesktopProxyConfig).not.toHaveBeenCalled();

    await act(async () => {
      resolveLoad?.({
        mode: "http",
        url: "http://127.0.0.1:7890",
        effective: "proxy",
        systemAvailable: true,
      });
    });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    expect(
      (
        screen.getByRole("combobox", {
          name: "Proxy mode",
        }) as HTMLSelectElement
      ).value,
    ).toBe("http");
  });

  it("keeps save disabled after load failure and allows an explicit retry", async () => {
    bridgeMocks.getDesktopProxyConfig
      .mockRejectedValueOnce(new Error("sidecar unavailable"))
      .mockResolvedValueOnce({
        mode: "system",
        effective: "system",
        systemAvailable: true,
      });

    render(<DesktopPane />);
    const save = screen.getByRole("button", { name: "Save and apply" });
    await screen.findByText("Could not load proxy settings");
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    expect(
      (
        screen.getByRole("combobox", {
          name: "Proxy mode",
        }) as HTMLSelectElement
      ).value,
    ).toBe("system");
  });
});

it("F-090 reports refresh failures and re-enables the action", async () => {
  vi.mocked(getDesktopInfo)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("offline"));
  render(<DesktopPane />);
  const button = screen.getByRole("button", {
    name: i18n.t("settings.desktopRefresh"),
  });
  await act(async () => fireEvent.click(button));
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("settings.desktopRefreshFailed"),
  );
  expect((button as HTMLButtonElement).disabled).toBe(false);
});
