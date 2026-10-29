import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_PAGE_READY_TIMEOUT_MS } from "@covel/shared";
import { PluginWebview } from "../plugin-webview.js";
import i18n from "@/i18n/index.js";
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  fetch: vi.fn(),
  theme: { scheme: "light", tokens: {} },
}));
vi.mock("../plugin-bridge.js", () => ({
  connectPluginBridge: (...args: unknown[]) => {
    mocks.connect(...args);
    return { pushState: vi.fn(), pushStream: vi.fn(), close: mocks.close };
  },
}));
vi.mock("@/theme-system/use-theme-snapshot.js", () => ({
  useThemeSnapshot: () => mocks.theme,
}));
const props = {
  title: "Page",
  src: `/plugin-assets/p/${"a".repeat(32)}/index.html`,
  state: {},
  locked: false,
  handlers: {},
};
const frame = () => screen.getByTitle<HTMLIFrameElement>("Page");
function ready() {
  const options = mocks.connect.mock.lastCall?.[3] as { onReady: () => void };
  act(() => options.onReady());
}
async function timeout() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PLUGIN_PAGE_READY_TIMEOUT_MS);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValue({ status: 200 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("URL-loaded plugin page", () => {
  it("loads directly with a base prefix, a strictly opaque sandbox and no document in the connection", () => {
    vi.stubEnv("BASE_URL", "/base/");
    const view = render(<PluginWebview {...props} />);
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame().getAttribute("src")).toBe(`/base${props.src}`);
    expect(frame().hasAttribute("srcdoc")).toBe(false);
    fireEvent.load(frame());
    expect(mocks.connect.mock.lastCall?.[1]).toBeUndefined();
    expect(
      view.container.firstElementChild?.getAttribute("data-page-status"),
    ).toBe("loading");
    ready();
    expect(
      view.container.firstElementChild?.getAttribute("data-page-status"),
    ).toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.load(frame());
    expect(mocks.connect).toHaveBeenCalledOnce();
  });
  it.each([404, 200, "network"])(
    "probes once after 8 seconds and shows the appropriate failure for %s",
    async (status) => {
      if (status === "network")
        mocks.fetch.mockRejectedValue(new Error("offline"));
      else mocks.fetch.mockResolvedValue({ status });
      render(<PluginWebview {...props} />);
      fireEvent.load(frame());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PLUGIN_PAGE_READY_TIMEOUT_MS - 1);
      });
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByRole("alert").textContent).toContain(
        i18n.t(
          status === 404 ? "session.pageUpdated" : "session.pageLoadFailed",
        ),
      );
      expect(frame()).toBeTruthy();
      expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(props.src, {
        method: "HEAD",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      });
      ready();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
  it("calls host Retry and remounts even when the returned digest stays the same", async () => {
    const onRetry = vi.fn();
    render(<PluginWebview {...props} onRetry={onRetry} />);
    const old = frame();
    fireEvent.load(old);
    await timeout();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("session.pageRetry") }),
    );
    expect(onRetry).toHaveBeenCalledOnce();
    expect(frame()).not.toBe(old);
    expect(mocks.close).toHaveBeenCalledOnce();
    fireEvent.load(frame());
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });
  it("remounts on Retry without a callback, or when a new digest arrives", async () => {
    const view = render(<PluginWebview {...props} />);
    const old = frame();
    await timeout();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("session.pageRetry") }),
    );
    expect(frame()).not.toBe(old);
    const retried = frame();
    view.rerender(
      <PluginWebview
        {...props}
        src={props.src.replace(/a{32}/, "b".repeat(32))}
      />,
    );
    expect(frame()).not.toBe(retried);
  });
  it("clears its timer and closes the port on unmount", () => {
    const view = render(<PluginWebview {...props} />);
    fireEvent.load(frame());
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("aborts an in-flight probe and ignores its eventual response after unmount", async () => {
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    const view = render(<PluginWebview {...props} />);
    await timeout();
    const options = mocks.fetch.mock.lastCall?.[1] as { signal: AbortSignal };
    view.unmount();
    expect(options.signal.aborted).toBe(true);
  });
});

it("keeps a late ready page visible when the outstanding failure probe settles", async () => {
  let resolve: ((value: { status: number }) => void) | undefined;
  mocks.fetch.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<PluginWebview {...props} />);
  fireEvent.load(frame());
  await timeout();
  ready();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => resolve?.({ status: 404 }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not let an old document's ready acknowledge a new digest", async () => {
  const view = render(<PluginWebview {...props} />);
  fireEvent.load(frame());
  const lastConnection = mocks.connect.mock.lastCall;
  if (!lastConnection) throw new Error("Page bridge did not connect");
  const options = lastConnection[3] as { onReady?: () => void } | undefined;
  if (!options || typeof options.onReady !== "function")
    throw new Error("Page bridge has no ready callback");
  const oldReady = options.onReady;
  view.rerender(
    <PluginWebview
      {...props}
      src={props.src.replace(/a{32}/, "b".repeat(32))}
    />,
  );
  fireEvent.load(frame());
  act(oldReady);
  await timeout();
  expect(screen.getByRole("alert")).toBeTruthy();
});
