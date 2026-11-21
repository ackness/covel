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

it("skips duplicate pushState messages when re-rendered with structurally identical state and pushes on real changes or reconnect", () => {
  const baseState = () => ({
    data: { hp: 10, tags: ["ready"] },
    context: {},
    session: structuredClone(projection),
  });
  const props = {
    title: "Reader",
    html: "one",
    locked: false,
    handlers: {},
  };
  const view = render(<PluginWebview {...props} state={baseState()} />);
  fireEvent.load(screen.getByTitle("Reader"));
  expect(mocks.connect).toHaveBeenCalledTimes(1);
  expect(mocks.push).not.toHaveBeenCalled();

  // Re-rendering with fresh inline object/array references carrying identical
  // values must not re-clone and post full state over the MessagePort.
  view.rerender(<PluginWebview {...props} state={baseState()} />);
  expect(mocks.push).not.toHaveBeenCalled();

  // A genuine data change pushes once, and repeating it does not push again.
  const updatedState = () => ({
    data: { hp: 8, tags: ["ready"] },
    context: {},
    session: structuredClone(projection),
  });
  view.rerender(<PluginWebview {...props} state={updatedState()} />);
  expect(mocks.push).toHaveBeenCalledTimes(1);
  expect(mocks.push.mock.lastCall?.[0]).toMatchObject({
    data: { hp: 8, tags: ["ready"] },
  });
  view.rerender(<PluginWebview {...props} state={updatedState()} />);
  expect(mocks.push).toHaveBeenCalledTimes(1);

  // Theme snapshot changes push even when props.state values stay identical.
  mocks.theme = { scheme: "dark", tokens: { background: "#111" } };
  view.rerender(<PluginWebview {...props} state={updatedState()} />);
  expect(mocks.push).toHaveBeenCalledTimes(2);
  expect(mocks.push.mock.lastCall?.[0]).toMatchObject({
    theme: { scheme: "dark", tokens: { background: "#111" } },
  });

  // Reloading the iframe resets the dedup cache cleanly for the new bridge.
  view.rerender(<PluginWebview {...props} html="two" state={updatedState()} />);
  fireEvent.load(screen.getByTitle("Reader"));
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  view.rerender(<PluginWebview {...props} html="two" state={updatedState()} />);
  expect(mocks.push).toHaveBeenCalledTimes(2);
  view.rerender(<PluginWebview {...props} html="two" state={baseState()} />);
  expect(mocks.push).toHaveBeenCalledTimes(3);
  mocks.theme = { scheme: "light", tokens: {} };
});
