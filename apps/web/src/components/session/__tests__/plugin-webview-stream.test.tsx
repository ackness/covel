import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginWebview } from "../plugin-webview.js";
import { projection } from "./plugin-view-fixtures.js";
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  append: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  theme: { scheme: "light", tokens: {} },
}));
vi.mock("../plugin-bridge.js", () => ({
  connectPluginBridge: (...args: unknown[]) => {
    mocks.connect(...args);
    return {
      pushState: mocks.push,
      pushStream: mocks.append,
      close: mocks.close,
    };
  },
}));
vi.mock("@/theme-system/use-theme-snapshot.js", () => ({
  useThemeSnapshot: () => mocks.theme,
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("baselines every full push with the current stream, flushes the tail and cleans up on HTML changes", () => {
  let value: { seq: number; text: string } | null = { seq: 2, text: "a" };
  const listeners = new Set<() => void>();
  const stream = {
    read: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const props = {
    title: "Reader",
    html: "one",
    state: { session: { ...projection, streaming: value } },
    locked: false,
    handlers: {},
    stream,
    fill: true,
  };
  const view = render(<PluginWebview {...props} />);
  fireEvent.load(screen.getByTitle("Reader"));
  expect(listeners.size).toBe(1);
  act(() => {
    value = { seq: 2, text: "ab" };
    for (const listener of listeners) listener();
    vi.advanceTimersByTime(100);
  });
  expect(mocks.append).toHaveBeenCalledExactlyOnceWith(2, "b");
  // A full update must use current text, rather than the old memoized projection.
  value = { seq: 2, text: "abc" };
  view.rerender(
    <PluginWebview {...props} state={{ ...props.state, locale: "en" }} />,
  );
  expect(mocks.push.mock.lastCall?.[0]).toMatchObject({
    session: { streaming: { seq: 2, text: "abc" } },
  });
  act(() => {
    value = { seq: 2, text: "abcd" };
    for (const listener of listeners) listener();
    value = null;
    for (const listener of listeners) listener();
  });
  expect(mocks.append.mock.lastCall).toEqual([2, "d"]);
  view.rerender(<PluginWebview {...props} html="two" />);
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  fireEvent.load(screen.getByTitle("Reader"));
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(mocks.close).toHaveBeenCalledTimes(2);
  expect(listeners.size).toBe(0);
});

it("can attach and detach a stream after the frame connects", () => {
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const stream = {
    read: () => ({ seq: 2, text: "a" }),
    subscribe: (notify: () => void) => {
      listener = notify;
      return unsubscribe;
    },
  };
  const props = {
    title: "Reader",
    html: "one",
    state: { session: { ...projection, streaming: { seq: 2, text: "a" } } },
    locked: false,
    handlers: {},
  };
  const view = render(<PluginWebview {...props} />);
  fireEvent.load(screen.getByTitle("Reader"));
  view.rerender(<PluginWebview {...props} stream={stream} />);
  expect(listener).toBeDefined();
  view.rerender(<PluginWebview {...props} />);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(listener).toBeUndefined();
});

it("withholds invalid full projections and subsequent stream appends", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  let text = "a";
  let notify: (() => void) | undefined;
  const stream = {
    read: () => ({ seq: 2, text }),
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => {};
    },
  };
  const view = render(
    <PluginWebview
      title="Invalid"
      html="one"
      state={{ session: { ...projection, phase: "invalid" } }}
      locked={false}
      handlers={{}}
      stream={stream}
    />,
  );
  fireEvent.load(screen.getByTitle("Invalid"));
  const host = mocks.connect.mock.calls[0]?.[2] as () => {
    state: Readonly<Record<string, unknown>>;
  };
  expect(host().state).not.toHaveProperty("session");
  act(() => {
    text = "ab";
    notify?.();
    vi.advanceTimersByTime(100);
  });
  expect(mocks.append).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledOnce();
  view.unmount();
  warning.mockRestore();
});
