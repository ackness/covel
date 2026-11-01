import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginWebview } from "../plugin-webview.js";
import { projection } from "./plugin-view-fixtures.js";
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  theme: { scheme: "light", tokens: {} },
}));
vi.mock("../plugin-bridge.js", () => ({
  connectPluginBridge: (...args: unknown[]) => {
    mocks.connect(...args);
    return { pushState: mocks.push, close: mocks.close };
  },
}));
vi.mock("@/theme-system/use-theme-snapshot.js", () => ({
  useThemeSnapshot: () => mocks.theme,
}));
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("sends complete state and retires the channel on HTML changes", () => {
  const props = {
    title: "Reader",
    html: "one",
    state: { session: projection },
    locked: false,
    handlers: {},
    fill: true,
  };
  const view = render(<PluginWebview {...props} />);
  fireEvent.load(screen.getByTitle("Reader"));
  const complete = {
    ...projection,
    executing: false,
    messages: [
      { seq: 2, role: "assistant" as const, text: "Full committed story" },
    ],
  };
  view.rerender(<PluginWebview {...props} state={{ session: complete }} />);
  expect(mocks.push.mock.lastCall?.[0]).toMatchObject({ session: complete });
  expect(mocks.push.mock.lastCall?.[0].session).not.toHaveProperty("streaming");
  view.rerender(<PluginWebview {...props} html="two" />);
  expect(mocks.close).toHaveBeenCalledOnce();
  fireEvent.load(screen.getByTitle("Reader"));
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(mocks.close).toHaveBeenCalledTimes(2);
});
it.each([
  { ...projection, version: 2 },
  { ...projection, phase: "invalid" },
  { ...projection, streaming: { text: "PRIVATE CANDIDATE" } },
])("withholds invalid or obsolete full projections", (session) => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  render(
    <PluginWebview
      title="Invalid"
      html="one"
      state={{ session }}
      locked={false}
      sessionPage
      handlers={{}}
    />,
  );
  fireEvent.load(screen.getByTitle("Invalid"));
  const host = mocks.connect.mock.calls[0]?.[2] as () => {
    state: Record<string, unknown>;
  };
  expect(host().state).not.toHaveProperty("session");
  expect(JSON.stringify(host())).not.toContain("PRIVATE CANDIDATE");
  expect(warning).toHaveBeenCalledOnce();
});
