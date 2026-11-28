import type { ComponentType } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  component: null as ComponentType | null,
  navigate: vi.fn(),
  booted: true,
  sid: undefined as string | undefined,
  executionRecovery: null as {
    sessionId: string;
    status: null;
    hydrating: boolean;
    checking: boolean;
    stalled?: boolean;
    error?: string;
  } | null,
  backToWorldSelect: vi.fn(),
  refreshExecutionRecovery: vi.fn(),
}));

const slotMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => {
    routeMocks.component = options.component;
    return { ...options, useSearch: () => ({ sid: routeMocks.sid }) };
  },
  useNavigate: () => routeMocks.navigate,
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      booted: routeMocks.booted,
      bootError: null,
      session: null,
      world: null,
      worlds: [],
      plugins: [],
      presets: [],
      llmConfig: null,
      messages: [],
      executionRecovery: routeMocks.executionRecovery,
      executionSteps: [],
    },
    boot: vi.fn(),
    selectWorld: vi.fn(),
    startGame: vi.fn(),
    resumeSession: vi.fn(),
    resumeSessionById: vi.fn().mockResolvedValue(undefined),
    retryInterruptedTurn: vi.fn(),
    refreshExecutionRecovery: routeMocks.refreshExecutionRecovery,
    abortActiveTurn: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn(),
    backToWorldSelect: routeMocks.backToWorldSelect,
    updateWorldLocal: vi.fn(),
    addWorldLocal: vi.fn(),
    removeWorldLocal: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-slot-config.js", () => ({
  useSlotConfig: () => ({ resolvedSlots: [], refresh: slotMocks.refresh }),
}));

vi.mock("@/components/session/world-select-screen.js", () => ({
  WorldSelectScreen: ({
    settingsOpen,
    onSettingsOpenChange,
  }: {
    settingsOpen: boolean;
    onSettingsOpenChange: (open: boolean) => void;
  }) => (
    <button onClick={() => onSettingsOpenChange(!settingsOpen)}>
      {settingsOpen ? "close settings" : "open settings"}
    </button>
  ),
}));

vi.mock("@/components/session/session-prep-screen.js", () => ({
  SessionPrepScreen: () => null,
}));

vi.mock("@/components/onboarding-wizard.js", () => ({
  OnboardingWizard: () => null,
}));

vi.mock("@/components/onboarding-wizard/persistence.js", () => ({
  isOnboarded: () => true,
}));

vi.mock("@/settings/SettingsDialog.js", () => ({
  SettingsDialog: () => null,
}));

vi.mock("@/lib/desktop-bridge.js", () => ({
  getCovelIpc: () => null,
  initDesktopBridge: () => vi.fn(),
  subscribeServerStatus: () => vi.fn(),
}));

beforeAll(async () => {
  await import("../session.js");
});

afterEach(() => {
  cleanup();
  routeMocks.booted = true;
  routeMocks.sid = undefined;
  routeMocks.executionRecovery = null;
  routeMocks.backToWorldSelect.mockClear();
  routeMocks.refreshExecutionRecovery.mockClear();
  slotMocks.refresh.mockClear();
  routeMocks.navigate.mockClear();
});

describe("session route world-select model summary", () => {
  it("re-reads the configured model after settings closes", () => {
    const SessionPage = routeMocks.component;
    if (!SessionPage) throw new Error("Session route was not registered");

    render(<SessionPage />);

    fireEvent.click(screen.getByRole("button", { name: "open settings" }));
    expect(slotMocks.refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "close settings" }));
    expect(slotMocks.refresh).toHaveBeenCalledTimes(1);
  });
});

it.each([false, true])("announces session loading when booted=%s", (booted) => {
  routeMocks.booted = booted;
  routeMocks.sid = "restoring-session";
  const SessionPage = routeMocks.component;
  if (!SessionPage) throw new Error("Session route was not registered");
  render(<SessionPage />);
  expect(screen.getByRole("status").textContent).toContain("加载中");
});

it("shows an actionable restore error screen with Back to worlds and Retry instead of spinning forever", () => {
  const SessionPage = routeMocks.component;
  if (!SessionPage) throw new Error("Session route was not registered");

  const { rerender } = render(<SessionPage />);
  routeMocks.executionRecovery = {
    sessionId: "old-save",
    status: null,
    hydrating: false,
    checking: false,
    stalled: true,
    error: "schemaVersion must be 3",
  };
  rerender(<SessionPage />);

  expect(screen.queryByRole("status")).toBeNull();
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("schemaVersion must be 3");

  fireEvent.click(screen.getByRole("button", { name: "返回世界列表" }));
  expect(routeMocks.backToWorldSelect).toHaveBeenCalledTimes(1);
  expect(routeMocks.navigate).toHaveBeenCalledWith({
    to: "/session",
    search: {},
    replace: true,
  });

  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(routeMocks.refreshExecutionRecovery).toHaveBeenCalledTimes(1);
});
