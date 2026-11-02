import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createSessionSubscription,
  pauseSessionSubscriptions,
  type SessionSubscription,
} from "../subscription.js";

// Keep IDB's real task queue separate from the fake reconnect clock.
vi.mock("../session-credentials.js", () => ({
  sessionAuthHeaders: async () => ({}),
  operatorAuthHeaders: () => ({}),
}));

const connectionId = "6d3fc2bd-9d96-4f77-9347-28cc2993f67e";
let subscription: SessionSubscription | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  subscription?.close();
  subscription = undefined;
  await vi.advanceTimersByTimeAsync(0);
  expect(
    JSON.stringify([
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]),
  ).not.toContain("PRIVATE_");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(header = connectionId) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "X-Covel-Subscription-Id": header } },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    frame(value: string) {
      stream.enqueue(new TextEncoder().encode(value));
    },
    eof() {
      stream.close();
    },
    error() {
      const error = new Error("PRIVATE_READ");
      error.name = "PRIVATE_NAME";
      stream.error(error);
    },
  };
}
function closes() {
  return vi
    .mocked(console.info)
    .mock.calls.filter(
      ([message]) => message === "[subscription] stream closed",
    )
    .map(([, value]) => value);
}

it.each(["reader-done", "read-error"] as const)(
  "correlates %s to the server identity and retains the existing reconnect delay",
  async (reason) => {
    const f = fixture();
    subscription = createSessionSubscription("session");
    await vi.advanceTimersByTimeAsync(0);
    expect(subscription.state).toBe("connected");
    if (reason === "reader-done") f.eof();
    else f.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(closes()).toEqual([
      expect.objectContaining({ connectionId, reason }),
    ]);
    expect(f.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  },
);

it("records malformed JSON and isolated handler errors without closing a healthy idle stream", async () => {
  const f = fixture();
  const received = vi.fn();
  subscription = createSessionSubscription("session");
  subscription.on("state", () => {
    const error = new Error("PRIVATE_HANDLER");
    error.name = "PRIVATE_NAME";
    throw error;
  });
  subscription.on("state", received);
  await vi.advanceTimersByTimeAsync(0);
  f.frame("event: state.changed\ndata: {PRIVATE_JSON\n\n");
  f.frame(
    'event: state.changed\ndata: {"payload":{"content":"PRIVATE_PAYLOAD"}}\n\n',
  );
  await vi.advanceTimersByTimeAsync(90000);
  expect(received).toHaveBeenCalledOnce();
  expect(console.warn).toHaveBeenCalledWith(
    "[subscription] stream diagnostic",
    expect.objectContaining({
      connectionId,
      type: "parse-rejected",
      errorKind: "syntax",
    }),
  );
  expect(console.warn).toHaveBeenCalledWith(
    "[subscription] stream diagnostic",
    expect.objectContaining({
      connectionId,
      type: "handler-error",
      errorKind: "error",
    }),
  );
  expect(closes()).toEqual([]);
  expect(subscription.state).toBe("connected");
  expect(f.fetch).toHaveBeenCalledOnce();
});

it.each([
  "close",
  "manual-reconnect",
  "action-pause",
  "visibility-hidden",
] as const)("records the caller's abort cause: %s", async (abortReason) => {
  const f = fixture();
  subscription = createSessionSubscription("session");
  await vi.advanceTimersByTimeAsync(0);
  let release: (() => void) | undefined;
  if (abortReason === "close") subscription.close();
  else if (abortReason === "manual-reconnect") subscription.reconnect();
  else if (abortReason === "action-pause")
    release = pauseSessionSubscriptions("session");
  else {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(closes()).toEqual([
    expect.objectContaining({ connectionId, reason: "abort", abortReason }),
  ]);
  expect(console.info).toHaveBeenCalledWith(
    "[subscription] stream diagnostic",
    expect.objectContaining({ type: "cancel", connectionId }),
  );
  expect(f.fetch).toHaveBeenCalledTimes(
    abortReason === "manual-reconnect" ? 2 : 1,
  );
  release?.();
});

it("does not log an arbitrary upstream correlation header", async () => {
  const f = fixture("PRIVATE_UPSTREAM_HEADER");
  subscription = createSessionSubscription("session");
  await vi.advanceTimersByTimeAsync(0);
  f.eof();
  await vi.advanceTimersByTimeAsync(0);
  expect(closes()).toEqual([
    expect.objectContaining({
      connectionId: undefined,
      attemptId: expect.any(String),
      reason: "reader-done",
    }),
  ]);
});
