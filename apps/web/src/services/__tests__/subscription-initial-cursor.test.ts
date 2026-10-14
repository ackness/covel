import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionSubscription,
  type SessionSubscription,
} from "../subscription.js";

let subscription: SessionSubscription | undefined;
afterEach(() => {
  subscription?.close();
  subscription = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function visibility(initial: DocumentVisibilityState) {
  let state = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  return (next: DocumentVisibilityState) => {
    state = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

/** A stream that sends `system.connected` naming `head` once released. */
function stubStream(head: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      await released;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: system.connected\ndata: ${JSON.stringify({ sessionId: "session", cursor: head })}\n\n`,
              ),
            );
          },
        }),
      );
    }),
  );
  const lastEventIds = () =>
    urls.map((url) =>
      new URL(url, "http://local").searchParams.get("lastEventId"),
    );
  return { release, lastEventIds };
}

describe("first subscription and the restored view (F-060)", () => {
  it("replays from the view's cursor when the first stream has not opened yet", async () => {
    const show = visibility("hidden");
    const stream = stubStream("epoch:9");
    const onMissedEvents = vi.fn();
    subscription = createSessionSubscription("session", { onMissedEvents });
    subscription.alignWithSnapshot("epoch:5");
    stream.release();
    show("visible");

    await vi.waitFor(() => expect(subscription?.state).toBe("connected"));
    expect(stream.lastEventIds()).toEqual(["epoch:5"]);
    expect(onMissedEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["registered after the view was read", "epoch:7", 1],
    ["registered in another epoch", "other:1", 1],
    ["registered at the view's read", "epoch:5", 0],
    ["registered before the view was read", "epoch:3", 0],
  ])(
    "reads again only when a stream opened without a cursor %s",
    async (_, head, missed) => {
      visibility("visible");
      const stream = stubStream(head);
      const onMissedEvents = vi.fn();
      subscription = createSessionSubscription("session", { onMissedEvents });
      await vi.waitFor(() => expect(stream.lastEventIds()).toEqual([null]));

      // The view arrives while the stream's request is still in flight.
      subscription.alignWithSnapshot("epoch:5");
      expect(onMissedEvents).not.toHaveBeenCalled();
      stream.release();

      await vi.waitFor(() => expect(subscription?.state).toBe("connected"));
      await vi.waitFor(() =>
        expect(onMissedEvents).toHaveBeenCalledTimes(missed),
      );
      subscription.alignWithSnapshot("epoch:5");
      expect(onMissedEvents).toHaveBeenCalledTimes(missed);
    },
  );

  it("checks a view that arrives after the stream connected", async () => {
    visibility("visible");
    const stream = stubStream("epoch:7");
    stream.release();
    const onMissedEvents = vi.fn();
    const received = vi.fn();
    subscription = createSessionSubscription("session", { onMissedEvents });
    subscription.on("*", received);
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(onMissedEvents).not.toHaveBeenCalled();

    subscription.alignWithSnapshot("epoch:5");
    expect(onMissedEvents).toHaveBeenCalledOnce();
  });
});
