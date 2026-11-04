import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { SessionSettingsDrawer } from "../session-settings-drawer.js";

const developer = vi.hoisted(() => ({ on: false }));
const confirm = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("@/settings/use-settings.js", () => ({
  useSetting: () => [developer.on, vi.fn()],
}));
vi.mock("../orchestration-settings.js", () => ({
  OrchestrationSettings: () => <fieldset>orchestration fields</fieldset>,
}));
vi.mock("../plugin-list-panel.js", () => ({
  PluginListPanel: (props: {
    developerMode?: boolean;
    onOpenModelSettings?: () => void;
  }) => (
    <div>
      plugin list {String(props.developerMode)}
      <button onClick={props.onOpenModelSettings}>to model settings</button>
    </div>
  ),
}));
vi.mock("@/lib/confirm-channel.js", () => ({
  requestConfirm: (request: unknown) => confirm.ask(request),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  developer.on = false;
  confirm.ask.mockReset();
});

const record = (id: string, turns: number): SessionRecord =>
  ({
    id,
    worldId: "w",
    locale: "en-US",
    status: "active",
    phase: "playing",
    completedPlayerTurns: turns,
    createdAt: "2026-03-04T05:06:07.000Z",
    setupRuntimes: {},
  }) as unknown as SessionRecord;
const world = { id: "w", name: "Ashfall", metadata: {} } as WorldRecord;

function show(
  overrides: Partial<Parameters<typeof SessionSettingsDrawer>[0]> = {},
) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    session: record("sess-current-id", 5),
    world,
    otherSessions: [record("sess-other-id", 2)],
    plugins: [],
    pluginLoadErrors: [],
    sessionPlugins: [],
    executing: false,
    resolvedSlots: [],
    onLoadSessions: vi.fn(),
    onSwitchSession: vi.fn(),
    onDeleteSession: vi.fn().mockResolvedValue(undefined),
    onTogglePlugin: vi.fn(),
    onOpenModelSettings: vi.fn(),
    ...overrides,
  };
  render(<SessionSettingsDrawer {...props} />);
  return props;
}

it("shows saves, plugins and a collapsed advanced block, with no raw ids", () => {
  const props = show();
  const drawer = screen.getByTestId("session-settings-drawer");
  expect(within(drawer).getByText("This game's settings")).toBeTruthy();
  expect(within(drawer).getByRole("region", { name: "Saves" })).toBeTruthy();
  expect(
    within(drawer).getByRole("region", { name: "Plugins in this game" }),
  ).toBeTruthy();
  expect(within(drawer).getByText("Advanced")).toBeTruthy();
  const details = drawer.querySelector("details");
  expect(details?.open).toBe(false);
  expect(within(drawer).getByText(/Ashfall · .*5.* · /)).toBeTruthy();
  expect(drawer.textContent).not.toContain("sess-current-id");
  expect(drawer.textContent).not.toContain("sess-other-id");
  expect(props.onLoadSessions).toHaveBeenCalled();
});

it("shows the raw id only in developer mode and passes the mode to the plugin list", () => {
  developer.on = true;
  show();
  const drawer = screen.getByTestId("session-settings-drawer");
  expect(drawer.textContent).toContain("sess-current-id");
  expect(drawer.textContent).toContain("plugin list true");
});

it("switches saves and deletes only after the player confirms", async () => {
  const props = show();
  fireEvent.click(screen.getByRole("button", { name: /^Switch save:/ }));
  expect(props.onSwitchSession).toHaveBeenCalledWith(props.otherSessions[0]);
  expect(props.onOpenChange).toHaveBeenCalledWith(false);

  confirm.ask.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: /^Delete save:/ }));
  await Promise.resolve();
  await Promise.resolve();
  expect(props.onDeleteSession).not.toHaveBeenCalled();

  confirm.ask.mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: /^Delete save:/ }));
  await vi.waitFor(() =>
    expect(props.onDeleteSession).toHaveBeenCalledWith("sess-other-id"),
  );
});

it("opens the model settings from the plugin list", () => {
  const props = show();
  fireEvent.click(screen.getByRole("button", { name: "to model settings" }));
  expect(props.onOpenModelSettings).toHaveBeenCalled();
});
