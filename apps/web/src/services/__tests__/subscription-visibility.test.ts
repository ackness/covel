import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionSubscription,
  pauseSessionSubscriptions,
  type SessionSubscription,
} from "../subscription.js";
import { sendAction } from "../api/actions.js";

let subscription: SessionSubscription | undefined;
afterEach(() => {
  subscription?.close();
  subscription = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function visibility(initial: DocumentVisibilityState = "visible") {
  let state = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  return (next: DocumentVisibilityState) => {
    state = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

describe("subscription visibility", () => {
  it("reports failed handlers without payloads and continues other subscribers", async () => {
    visibility();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'id: epoch:1\nevent: state.changed\ndata: {"payload":{"privateText":"private-value"}}\n\n',
                  ),
                );
              },
            }),
          ),
      ),
    );
    const broken = () => {
      throw new Error("private-value");
    };
    const received = vi.fn();
    subscription = createSessionSubscription("session");
    subscription.on("state", broken);
    subscription.on("state", received);
    subscription.on("*", broken);
    subscription.on("*", received);

    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
    expect(subscription.state).toBe("connected");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("[subscription] event handler failed", {
      sessionId: "session",
      eventType: "state.changed",
      eventId: "epoch:1",
      errorType: "Error",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
  });

  it.each(["complete", "error", "abort"] as const)(
    "resumes the auxiliary stream after an action ends with %s",
    async (end) => {
      visibility();
      let actionStream!: ReadableStreamDefaultController<Uint8Array>;
      const fetch = vi.fn(
        async (url: string) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (url === "/api/actions") actionStream = controller;
              },
            }),
          ),
      );
      vi.stubGlobal("fetch", fetch);
      subscription = createSessionSubscription("session");
      await vi.waitFor(() => expect(subscription!.state).toBe("connected"));
      const action = sendAction(
        {
          type: "send_message",
          requestId: "action",
          sessionId: "session",
          payload: { content: "Go" },
        },
        vi.fn(),
        vi.fn(),
      );
      expect(subscription.state).toBe("paused");
      await vi.waitFor(() => expect(actionStream).toBeDefined());
      if (end === "complete") actionStream.close();
      else if (end === "error") actionStream.error(new Error("Disconnected"));
      else action.abort();
      await vi.waitFor(() => expect(subscription!.state).toBe("connected"));
      expect(
        fetch.mock.calls
          .map(([url]) => url)
          .filter((url) => url.includes("/api/events/stream")),
      ).toHaveLength(2);
    },
  );

  it("keeps subscriptions paused until all action streams release and the tab is visible", async () => {
    const setVisibility = visibility();
    const fetch = vi.fn(async () => new Response(new ReadableStream()));
    vi.stubGlobal("fetch", fetch);
    const releaseFirst = pauseSessionSubscriptions();
    const releaseSecond = pauseSessionSubscriptions();
    try {
      subscription = createSessionSubscription("session");
      expect(subscription.state).toBe("paused");
      releaseFirst();
      releaseFirst();
      expect(fetch).not.toHaveBeenCalled();
      setVisibility("hidden");
      releaseSecond();
      expect(fetch).not.toHaveBeenCalled();
      setVisibility("visible");
      await vi.waitFor(() => expect(subscription!.state).toBe("connected"));
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      releaseFirst();
      releaseSecond();
    }
  });
  it("releases a hidden tab's stream and resumes from its cursor", async () => {
    const setVisibility = visibility();
    const cancel = vi.fn();
    const fetch = vi.fn().mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'id: epoch:4\nevent: plugin-data.changed\ndata: {"payload":{"value":4}}\n\n',
                ),
              );
            },
            cancel,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const event = vi.fn();
    subscription = createSessionSubscription("session");
    subscription.on("*", event);
    await vi.waitFor(() => expect(event).toHaveBeenCalledOnce());
    setVisibility("hidden");
    expect(subscription.state).toBe("paused");
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    setVisibility("visible");
    await vi.waitFor(() => expect(subscription!.state).toBe("connected"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toContain("lastEventId=epoch%3A4");
    subscription.close();
    setVisibility("hidden");
    setVisibility("visible");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not occupy a connection when opened in the background", async () => {
    const setVisibility = visibility("hidden");
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream()));
    vi.stubGlobal("fetch", fetch);
    const states: string[] = [];
    subscription = createSessionSubscription("session", {
      onStateChange: (state) => states.push(state),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(states).toEqual(["paused"]);
    setVisibility("visible");
    await vi.waitFor(() => expect(subscription!.state).toBe("connected"));
    expect(states).toEqual(["paused", "reconnecting", "connected"]);
  });

  it("discards late response headers from the stream replaced on visibility resume", async () => {
    const setVisibility = visibility();
    let resolveOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const cancel = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue(new Response(new ReadableStream()));
    vi.stubGlobal("fetch", fetch);
    subscription = createSessionSubscription("session");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    setVisibility("hidden");
    setVisibility("visible");
    await vi.waitFor(() => expect(subscription!.state).toBe("connected"));
    resolveOld(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(subscription.state).toBe("connected");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
