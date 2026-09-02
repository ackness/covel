import type { ComponentType } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  component: null as ComponentType | null,
  navigate: vi.fn(),
}));

const slotMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => {
    routeMocks.component = options.component;
    return { ...options, useSearch: () => ({}) };
  },
  useNavigate: () => routeMocks.navigate,
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      booted: true,
      bootError: null,
      session: null,
      world: null,
      worlds: [],
      packages: [],
      presets: [],
      llmConfig: null,
      messages: [],
    },
    boot: vi.fn(),
    selectWorld: vi.fn(),
    startGame: vi.fn(),
    resumeSession: vi.fn(),
    resumeSessionById: vi.fn(),
    deleteSession: vi.fn(),
    backToWorldSelect: vi.fn(),
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

vi.mock("@/lib/desktop-bridge.js", () => ({
  initDesktopBridge: () => vi.fn(),
}));

beforeAll(async () => {
  await import("../session.js");
});

afterEach(() => {
  cleanup();
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
