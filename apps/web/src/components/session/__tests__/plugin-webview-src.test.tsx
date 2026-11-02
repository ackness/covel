import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { PLUGIN_PAGE_READY_TIMEOUT_MS } from "@covel/shared";
import { PluginWebview } from "../plugin-webview.js";
import i18n from "@/i18n/index.js";
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  ping: vi.fn(),
  fetch: vi.fn(),
  theme: { scheme: "light", tokens: {} },
}));
vi.mock("../plugin-bridge.js", () => ({
  connectPluginBridge: (...args: unknown[]) => {
    mocks.connect(...args);
    return {
      pushState: vi.fn(),
      close: mocks.close,
      ping: mocks.ping,
    };
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

describe("host surface recovery", () => {
  const options = () =>
    mocks.connect.mock.lastCall?.[3] as {
      onReady(): void;
      onPageError(): void;
      onPong(id: number): void;
    };
  it.each(["inline", "url"])(
    "retires a %s page after the mount timeout without a load event",
    async (delivery) => {
      const failed = vi.fn();
      render(
        <PluginWebview
          {...props}
          src={delivery === "url" ? props.src : undefined}
          html="<p>Inline</p>"
          onPageFailure={failed}
        />,
      );
      await timeout();
      expect(failed).toHaveBeenCalledOnce();
      fireEvent.load(frame());
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["error", "navigation", "load-error"])(
    "falls back exactly once for %s and ignores late ready",
    (failure) => {
      const failed = vi.fn();
      render(<PluginWebview {...props} onPageFailure={failed} />);
      fireEvent.load(frame());
      const callbacks = options();
      act(callbacks.onReady);
      if (failure === "error") act(callbacks.onPageError);
      if (failure === "navigation") fireEvent.load(frame());
      if (failure === "load-error") fireEvent.error(frame());
      act(callbacks.onPageError);
      act(callbacks.onReady);
      expect(failed).toHaveBeenCalledOnce();
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("measures the document event loop with matched probes, then retires after three missed replies", async () => {
    const failed = vi.fn();
    render(<PluginWebview {...props} onPageFailure={failed} />);
    fireEvent.load(frame());
    ready();
    for (let id = 1; id <= 4; id++) {
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(mocks.ping).toHaveBeenLastCalledWith(id);
      act(() => options().onPong(id));
    }
    expect(failed).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(mocks.ping).toHaveBeenCalledTimes(7);
    expect(failed).toHaveBeenCalledOnce();
  });
  it("restores the host composer when a retried page stops answering heartbeats", async () => {
    const failed = vi.fn();
    function Surface() {
      const [active, setActive] = useState(true);
      return (
        <>
          <section aria-label="Main story">
            Public story remains visible
          </section>
          {active ? (
            <section aria-label="Bridge input">
              <PluginWebview
                {...props}
                onPageFailure={() => {
                  failed();
                  setActive(false);
                }}
              />
            </section>
          ) : (
            <>
              <textarea aria-label="Host composer" />
              <button onClick={() => setActive(true)}>Retry</button>
            </>
          )}
        </>
      );
    }
    render(<Surface />);
    fireEvent.load(frame());
    ready();
    const retired = options();
    act(retired.onPageError);
    expect(screen.queryByRole("region", { name: "Bridge input" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Host composer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.load(frame());
    ready();
    act(retired.onReady);
    await act(async () => vi.advanceTimersByTimeAsync(19_999));
    expect(screen.getByRole("region", { name: "Bridge input" })).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.queryByRole("region", { name: "Bridge input" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Host composer" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Main story" })).toBeTruthy();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores background sleep and grants a fresh visible grace before probing", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const failed = vi.fn();
    render(<PluginWebview {...props} onPageFailure={failed} />);
    fireEvent.load(frame());
    ready();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(failed).not.toHaveBeenCalled();
    mocks.ping.mockClear();
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(7999));
    expect(mocks.ping).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.ping).toHaveBeenCalledExactlyOnceWith(3);
    expect(failed).not.toHaveBeenCalled();
    visibility.mockRestore();
  });
  it("drops a timed-out attempt's late ready after explicit remount", async () => {
    const failed = vi.fn();
    const view = render(<PluginWebview {...props} onPageFailure={failed} />);
    fireEvent.load(frame());
    const old = options();
    await timeout();
    view.rerender(
      <PluginWebview
        {...props}
        src={props.src.replace(/a{32}/, "c".repeat(32))}
        onPageFailure={failed}
      />,
    );
    fireEvent.load(frame());
    act(old.onReady);
    await timeout();
    expect(failed).toHaveBeenCalledTimes(2);
  });
});

it("retires a session surface with invalid required public state before the first port transfer", () => {
  const failed = vi.fn();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  render(
    <PluginWebview
      {...props}
      state={{ session: { private: "must-not-post" } }}
      sessionPage
      onPageFailure={failed}
    />,
  );
  fireEvent.load(frame());
  expect(failed).toHaveBeenCalledOnce();
  expect(mocks.connect).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("pauses the ready deadline while hidden and gives an unready document fresh visible grace", async () => {
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const failed = vi.fn();
  render(<PluginWebview {...props} onPageFailure={failed} />);
  await act(async () => vi.advanceTimersByTimeAsync(120000));
  expect(failed).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => vi.advanceTimersByTimeAsync(7999));
  expect(failed).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(failed).toHaveBeenCalledOnce();
  visibility.mockRestore();
});
