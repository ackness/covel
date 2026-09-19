import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { OnboardingWizard } from "../../onboarding-wizard.js";
import { ONBOARDING_VERSION } from "../constants.js";
import { isOnboarded, markOnboarded, resetOnboarding } from "../persistence.js";

const settings = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("@/settings/store.js", () => ({ getSettings: () => settings }));
vi.mock("@/hooks/useLocalePreference.js", () => ({
  useLocalePreference: () => ({ locale: "zh-CN", setLocale: vi.fn() }),
}));
vi.mock("@/components/shared/ping-button.js", () => ({
  PingButton: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  settings.set.mockReset().mockResolvedValue(undefined);
  settings.clear.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(true);
  const [target, setTarget] = useState("");
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <OnboardingWizard
        open={open}
        onOpenChange={setOpen}
        settingsOpen={!!target}
        onOpenSettings={setTarget}
        resolvedSlots={[]}
      />
      {target && <button onClick={() => setTarget("")}>{target}</button>}
    </>
  );
}

describe("getting started guide", () => {
  it("keeps the guide open until completion is persisted and deduplicates dismissals", async () => {
    let resolveSave!: () => void;
    const save = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    settings.set.mockReturnValue(save);
    render(<Harness />);
    const skip = screen.getByRole("button", { name: "先浏览世界" });
    fireEvent.click(skip);
    fireEvent.click(skip);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((skip as HTMLButtonElement).disabled).toBe(true);
    expect(settings.set).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a failed completion visible and allows retry", async () => {
    settings.set.mockRejectedValueOnce(new Error("storage unavailable"));
    render(<Harness />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "先浏览世界" })),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("设置保存失败");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "先浏览世界" })),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(settings.set).toHaveBeenCalledTimes(2);
  });

  it("returns from real settings entry points to the same step and never claims missing models are ready", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "开始引导" }));
    expect(screen.getByRole("status").textContent).toContain("尚未检测到");
    fireEvent.click(screen.getByRole("button", { name: "配置服务商与模型" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "llm.providers" }));
    expect(
      screen.getByRole("heading", { name: "连接故事所需的模型" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "检查用途分配" }));
    fireEvent.click(screen.getByRole("button", { name: "llm.slots" }));
    fireEvent.click(screen.getByRole("button", { name: "了解如何游玩" }));
    expect(screen.getByRole("status").textContent).toContain(
      "开始游戏前请完成模型设置",
    );
    expect(settings.set).not.toHaveBeenCalled();
    expect(settings.clear).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "去选择世界" })),
    );
    expect(settings.set).toHaveBeenCalledExactlyOnceWith(
      "ui.onboardedVersion",
      ONBOARDING_VERSION,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(
      screen.getByRole("heading", { name: "欢迎来到 Covel" }),
    ).toBeTruthy();
  });
  it("lets a user skip and reopen without changing model configuration", async () => {
    render(<Harness />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "先浏览世界" })),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(settings.set).toHaveBeenCalledExactlyOnceWith(
      "ui.onboardedVersion",
      ONBOARDING_VERSION,
    );
    expect(settings.clear).not.toHaveBeenCalled();
  });
  it("revisits an older guide once and only resets its own preference", async () => {
    settings.get.mockReturnValue(ONBOARDING_VERSION - 1);
    expect(isOnboarded()).toBe(false);
    settings.get.mockReturnValue(ONBOARDING_VERSION);
    expect(isOnboarded()).toBe(true);
    await markOnboarded();
    await resetOnboarding();
    expect(settings.set).toHaveBeenCalledExactlyOnceWith(
      "ui.onboardedVersion",
      ONBOARDING_VERSION,
    );
    expect(settings.clear).toHaveBeenCalledExactlyOnceWith(
      "ui.onboardedVersion",
    );
  });
});
