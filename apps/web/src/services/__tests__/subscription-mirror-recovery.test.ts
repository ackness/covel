// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createSessionSubscription,
  pauseSessionSubscriptions,
  type SessionSubscription,
} from "../subscription.js";
import { createSessionWorkspace } from "../data-service/workspace.js";
import type {
  DataService,
  SessionWorkspaceOperations,
} from "../data-service/types.js";

// Credentials are unrelated to restart ordering; avoid IDB's real task queue
// while driving subscription backoff with fake timers.
vi.mock("../session-credentials.js", () => ({
  sessionAuthHeaders: async () => ({}),
  operatorAuthHeaders: () => ({}),
}));

let subscriptions: SessionSubscription[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const subscription of subscriptions) subscription.close();
  subscriptions = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => vi.advanceTimersByTimeAsync(0);
const missing = () => new Response("Session not found", { status: 404 });

it.each([false, true])(
  "serializes mirror upload after a restart (pause during upload: %s)",
  async (pause) => {
    let mirrored = true;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const upload = deferred();
    const order: string[] = [];
    let queue = Promise.resolve();
    const workspace = createSessionWorkspace(
      {
        withSessionWorkspace: (
          _id: string,
          work: (operations: SessionWorkspaceOperations) => Promise<unknown>,
        ) => {
          const pending = queue.then(() =>
            work({
              hydrate: async () => {
                order.push("hydrate");
                await upload.promise;
                mirrored = true;
                order.push("uploaded");
              },
            } as SessionWorkspaceOperations),
          );
          queue = pending.then(() => undefined);
          return pending;
        },
      } as unknown as DataService,
      "local",
    );
    const fetch = vi.fn(async () => {
      order.push(mirrored ? "stream" : "404");
      return mirrored
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                stream = c;
              },
            }),
          )
        : missing();
    });
    vi.stubGlobal("fetch", fetch);
    const events = vi.fn();
    const sub = createSessionSubscription("session", {
      recoverMissingSession: () => workspace.hydrate("session"),
    });
    subscriptions.push(sub);
    sub.on("*", events);
    await tick();
    expect(sub.state).toBe("connected");
    mirrored = false;
    stream.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(["stream", "404", "hydrate"]);
    // Pausing and resuming during hydrate must neither open a stream early nor
    // duplicate the workspace upload.
    if (pause) {
      const release = pauseSessionSubscriptions();
      release();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    upload.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    expect(order).toEqual(["stream", "404", "hydrate", "uploaded", "stream"]);
    stream.enqueue(
      new TextEncoder().encode(
        'event: plugin-data.changed\ndata: {"payload":{"value":"after restart"}}\n\n',
      ),
    );
    await tick();
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "plugin-data.changed",
        payload: { value: "after restart" },
      }),
    );
    expect(sub.state).toBe("connected");
  },
);

it("cannot revive the old session when its pending upload finishes", async () => {
  const upload = deferred();
  const hydrate = vi.fn(() => upload.promise);
  const fetch = vi.fn(async (url: string) =>
    url.includes("sessionId=old")
      ? missing()
      : new Response(new ReadableStream()),
  );
  vi.stubGlobal("fetch", fetch);
  const old = createSessionSubscription("old", {
    recoverMissingSession: hydrate,
  });
  subscriptions.push(old);
  await tick();
  expect(hydrate).toHaveBeenCalledOnce();
  old.close();
  const current = createSessionSubscription("current");
  subscriptions.push(current);
  upload.resolve();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(old.state).toBe("closed");
  expect(current.state).toBe("connected");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 404])(
  "retains bounded remote %s errors without hydration",
  async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response("unavailable", { status }));
    vi.stubGlobal("fetch", fetch);
    const sub = createSessionSubscription("remote");
    subscriptions.push(sub);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sub.state).toBe("closed");
    expect(fetch).toHaveBeenCalledTimes(5);
  },
);

it("bounds failed mirror recovery and does not hydrate authentication errors", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const hydrate = vi
    .fn()
    .mockRejectedValue(new Error("synthetic upload failure"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => missing()),
  );
  const sub = createSessionSubscription("local", {
    recoverMissingSession: hydrate,
  });
  subscriptions.push(sub);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sub.state).toBe("closed");
  expect(hydrate).toHaveBeenCalledTimes(5);
  hydrate.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("unauthorized", { status: 401 })),
  );
  const unauthorized = createSessionSubscription("local", {
    recoverMissingSession: hydrate,
  });
  subscriptions.push(unauthorized);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(unauthorized.state).toBe("closed");
  expect(hydrate).not.toHaveBeenCalled();
});

it.each([true, false])(
  "verifies a successful fifth upload exactly once (mirror restored: %s)",
  async (restored) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let mirrored = false;
    const hydrate = vi.fn(async () => {
      if (hydrate.mock.calls.length < 5)
        throw new Error("synthetic upload failure");
      mirrored = restored;
    });
    const fetch = vi.fn(async () =>
      mirrored ? new Response(new ReadableStream()) : missing(),
    );
    vi.stubGlobal("fetch", fetch);
    const sub = createSessionSubscription("local", {
      recoverMissingSession: hydrate,
    });
    subscriptions.push(sub);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hydrate).toHaveBeenCalledTimes(5);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(sub.state).toBe(restored ? "connected" : "closed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hydrate).toHaveBeenCalledTimes(5);
    expect(fetch).toHaveBeenCalledTimes(6);
  },
);

it("bounds successful recovery callbacks when the stream stays missing", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const hydrate = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn(async () => missing());
  vi.stubGlobal("fetch", fetch);
  const sub = createSessionSubscription("local", {
    recoverMissingSession: hydrate,
  });
  subscriptions.push(sub);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sub.state).toBe("closed");
  expect(hydrate).toHaveBeenCalledTimes(5);
  expect(fetch).toHaveBeenCalledTimes(6);
});

it("manually reconnects after giving up and retains registered event handlers", async () => {
  const fetch = vi.fn(
    async () => new Response("unauthorized", { status: 401 }),
  );
  vi.stubGlobal("fetch", fetch);
  const sub = createSessionSubscription("manual-reconnect");
  const received = vi.fn();
  sub.on("state", received);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sub.state).toBe("closed");
  fetch.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'id: epoch:1\nevent: state.changed\ndata: {"payload":{}}\n\n',
              ),
            );
          },
        }),
      ),
  );
  sub.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(sub.state).toBe("connected");
  expect(received).toHaveBeenCalledOnce();
  sub.close();
});
