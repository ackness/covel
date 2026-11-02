import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import { createApplicationWork } from "../../src/application-work.js";
import { invalidateSessionEvents } from "../../src/routes/api/session/session-events.js";
import { emitSeq, makeApp, seedSession } from "./sse-test-utils.js";

const privateText = "PRIVATE_TOKEN_URL_PROMPT";
const resources: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    JSON.stringify([
      vi.mocked(console.info).mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls,
    ]),
  ).not.toContain(privateText);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function closes() {
  return vi
    .mocked(console.info)
    .mock.calls.filter(([message]) => message === "[subscribe] stream closed")
    .map(([, detail]) => detail);
}

async function fixture() {
  const store = createMemoryStore();
  const bus = createEventBus();
  const work = createApplicationWork();
  await seedSession(store, "diagnostics");
  const app = new Hono()
    .use("*", work.middleware)
    .route("/", makeApp(store, bus));
  resources.push(async () => {
    await work.close();
    await bus.close();
  });
  async function open(query = "") {
    const response = await app.request(
      `/api/events/stream?sessionId=diagnostics${query}`,
    );
    const reader = response.body!.getReader();
    resources.push(async () => {
      await reader.cancel();
    });
    return { response, reader };
  }
  async function live() {
    const stream = await open();
    const first = new TextDecoder().decode((await stream.reader.read()).value);
    const connectionId = stream.response.headers.get("X-Covel-Subscription-Id");
    expect(first).toContain(`"connectionId":"${connectionId}"`);
    expect(stream.response.headers.get("Access-Control-Expose-Headers")).toBe(
      "X-Covel-Subscription-Id",
    );
    await vi.advanceTimersByTimeAsync(0);
    return { ...stream, connectionId };
  }
  return { store, bus, work, open, live };
}

it.each([
  "session-invalidated",
  "event-bus-reset",
  "peer-abort",
  "host-shutdown",
  "queue-overflow",
] as const)("records one correlated close for %s", async (reason) => {
  const { store, bus, work, live } = await fixture();
  const { reader, connectionId } = await live();
  if (reason === "session-invalidated") {
    const session = await store.getSession("diagnostics");
    if (!session) throw new Error("fixture missing");
    invalidateSessionEvents(bus, session);
  } else if (reason === "event-bus-reset") {
    bus.invalidateReplay?.("diagnostics", "transport-gap");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "system.reset",
    );
  } else if (reason === "host-shutdown") await work.close();
  else if (reason === "peer-abort") await reader.cancel();
  else for (let n = 0; n < 300; n++) emitSeq(bus, "diagnostics", "state", n);
  while (!(await reader.read()).done) {
    /* Drain any already buffered frame. */
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(closes()).toEqual([
    expect.objectContaining({ connectionId, reason, phase: "live" }),
  ]);
  if (reason === "event-bus-reset")
    expect(closes()[0]).toMatchObject({ resetReason: "transport-gap" });
});

it.each([
  "identity-read-error",
  "session-missing",
  "session-replaced",
] as const)("distinguishes identity rechecks: %s", async (reason) => {
  const { store, bus, live } = await fixture();
  const { reader, connectionId } = await live();
  if (reason === "identity-read-error") {
    const error = new Error(privateText);
    error.name = privateText;
    vi.spyOn(store, "getSession").mockRejectedValueOnce(error);
  } else {
    await store.deleteSession("diagnostics");
    if (reason === "session-replaced") {
      await seedSession(store, "diagnostics");
      await store.updateSession("diagnostics", {
        metadata: { sessionIncarnationNonce: "replacement" },
      });
    }
  }
  bus.emit({
    id: "stale",
    type: "event",
    topic: "state",
    sessionId: "diagnostics",
    sessionIncarnation: "stale",
    timestamp: "now",
    payload: { secret: privateText },
  });
  expect((await reader.read()).done).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(closes()).toEqual([expect.objectContaining({ connectionId, reason })]);
});

it("distinguishes a rejected write from a write deadline without logging the error", async () => {
  const { open } = await fixture();
  vi.spyOn(SSEStreamingApi.prototype, "writeSSE").mockRejectedValueOnce(
    new TypeError(privateText),
  );
  const { reader } = await open();
  expect((await reader.read()).done).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(closes()).toEqual([
    expect.objectContaining({
      reason: "write-error",
      errorKind: "type",
      phase: "handshake",
    }),
  ]);
});

it("identifies handshake buffer overflow separately from EventBus reset", async () => {
  const { store, bus, open } = await fixture();
  const get = store.getSession.bind(store);
  vi.spyOn(store, "getSession").mockImplementationOnce(async (id) => {
    for (let n = 0; n < 257; n++) emitSeq(bus, id, "state", n);
    return get(id);
  });
  const { reader } = await open();
  expect((await reader.read()).done).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(closes()).toEqual([
    expect.objectContaining({
      reason: "handshake-overflow",
      phase: "handshake",
    }),
  ]);
});

it("keeps healthy idle and stale-cursor handshake streams open through three heartbeat intervals", async () => {
  const { open } = await fixture();
  for (const query of ["", "&lastEventId=old:1"]) {
    const { reader } = await open(query);
    await reader.read();
    if (query)
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "system.reset",
      );
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 0; n < 3; n++) {
      const heartbeat = reader.read();
      await vi.advanceTimersByTimeAsync(30000);
      const frame = await heartbeat;
      expect(frame.done).toBe(false);
      expect(new TextDecoder().decode(frame.value)).toContain(
        "system.heartbeat",
      );
    }
    expect(closes()).toEqual([]);
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(closes()).toEqual([
      expect.objectContaining({ reason: "peer-abort" }),
    ]);
    vi.mocked(console.info).mockClear();
  }
});
