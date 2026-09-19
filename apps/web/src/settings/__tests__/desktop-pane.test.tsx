import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { DesktopPane } from "../DesktopPane.js";

const bridgeMocks = vi.hoisted(() => ({
  getDesktopProxyConfig: vi.fn(),
  setDesktopProxyConfig: vi.fn(),
  resetOnboarding: vi.fn(),
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { llmConfig: { configured: true } } }),
}));

vi.mock("@/components/onboarding-wizard.js", () => ({
  resetOnboarding: bridgeMocks.resetOnboarding,
}));

vi.mock("@/lib/desktop-bridge.js", () => ({
  hasElectronIpc: () => false,
  isDesktopApp: () => true,
  getDesktopInfo: vi.fn().mockResolvedValue(null),
  getDesktopProxyConfig: bridgeMocks.getDesktopProxyConfig,
  setDesktopProxyConfig: bridgeMocks.setDesktopProxyConfig,
  openLogsDir: vi.fn(),
  openConfigDir: vi.fn(),
  openDataDir: vi.fn(),
  openLlmToml: vi.fn().mockResolvedValue(undefined),
  openKeysEnv: vi.fn().mockResolvedValue(undefined),
  pickDataDir: vi.fn().mockResolvedValue(null),
  reloadServerAndWait: vi.fn(),
}));

describe("DesktopPane proxy loading", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    bridgeMocks.getDesktopProxyConfig.mockReset();
    bridgeMocks.setDesktopProxyConfig.mockReset();
    bridgeMocks.resetOnboarding.mockReset().mockResolvedValue(undefined);
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
    expect(screen.getByText(i18n.t("settings.saveFailed"))).toBeTruthy();
    expect(
      screen.queryByText(i18n.t("settings.desktopOnboardingResetToast")),
    ).toBeNull();
    await act(async () => fireEvent.click(button));
    expect(
      screen.getByText(i18n.t("settings.desktopOnboardingResetToast")),
    ).toBeTruthy();
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
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "http",
    );
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
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "system",
    );
  });
});
