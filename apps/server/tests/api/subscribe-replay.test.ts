/**
 * `/api/events/stream` reconnect + replay/live race regression tests (R-01).
 *
 * Bug B (cursor reset): the synthetic `system.connected` frame must NOT carry
 * an SSE `id:`. When it did (`id: "0"`), the frontend's
 * `if (message.id) lastEventId = message.id` reset the cursor to "0" on every
 * reconnect, forcing a full-buffer replay.
 *
 * Bug A (event-loss race): the live `onEmit` listener must be registered
 * BEFORE the replay batch is computed/written. An event emitted while replay is
 * still draining (the consumer applies backpressure, so the replay loop is
 * suspended on our reads) must be delivered exactly once — not lost, not
 * duplicated.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createEventBus, type EventBus } from "@covel/events";
import { createMemoryStore, type DataStore } from "@covel/store";
import { subscribeRoutes } from "../../src/routes/api/subscribe.js";

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

function parseBlock(block: string): Frame {
  const frame: Frame = {};
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) frame.id = line.slice(3).replace(/^ /, "");
    else if (line.startsWith("event:"))
      frame.event = line.slice(6).replace(/^ /, "");
    else if (line.startsWith("data:"))
      frame.data = line.slice(5).replace(/^ /, "");
  }
  return frame;
}

function isSystemFrame(f: Frame): boolean {
  return f.event === "system.connected" || f.event === "system.heartbeat";
}

/**
 * Drain SSE frames from a reader until `want` non-system frames have arrived
 * or the deadline elapses. `onFrame` fires for every parsed frame — used to
 * inject an emit mid-replay while the producer is suspended on our reads.
 */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: {
    deadlineMs: number;
    want?: number;
    onFrame?: (frame: Frame, frames: Frame[]) => void;
  },
): Promise<Frame[]> {
  const decoder = new TextDecoder();
  let buf = "";
  const frames: Frame[] = [];
  const deadline = Date.now() + opts.deadlineMs;

  while (Date.now() < deadline) {
    const timeoutP = new Promise<"__timeout__">((r) =>
      setTimeout(() => r("__timeout__"), Math.max(1, deadline - Date.now())),
    );
    const result = await Promise.race([reader.read(), timeoutP]);
    if (result === "__timeout__") break;
    const { done, value } = result;
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!block.trim()) continue;
      const frame = parseBlock(block);
      frames.push(frame);
      opts.onFrame?.(frame, frames);
      if (
        opts.want !== undefined &&
        frames.filter((f) => !isSystemFrame(f)).length >= opts.want
      ) {
        return frames;
      }
    }
  }
  return frames;
}

function makeApp(store: DataStore, eventBus: EventBus): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("eventBus", eventBus);
    await next();
  });
  app.route("/api/events", subscribeRoutes);
  return app;
}

const SESSION_ID = "sess-replay";

async function seedSession(store: DataStore): Promise<void> {
  await store.createSession({
    id: SESSION_ID,
    worldId: null,
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    presetId: null,
    activePlugins: [],
    createdAt: new Date().toISOString(),
  });
}

function emitSeq(eventBus: EventBus, topic: string, n: number): void {
  eventBus.emit({
    id: `msg-${n}`,
    type: "event",
    topic,
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    payload: { n },
  });
}

describe("R-01 SSE reconnect + replay/live race", () => {
  let store: DataStore;
  let eventBus: EventBus;
  let app: Hono;

  beforeEach(async () => {
    store = createMemoryStore();
    eventBus = createEventBus();
    app = makeApp(store, eventBus);
    await seedSession(store);
  });

  it("Bug B: connected frame carries no id, so reconnect does not reset the cursor / no full replay when nothing missed", async () => {
    // Three events already in the buffer (ids "1".."3").
    for (let n = 1; n <= 3; n++) emitSeq(eventBus, "state", n);

    const ac = new AbortController();
    try {
      // Reconnect at the tip (lastEventId="3") — nothing is newer, so replay
      // must be empty and the only frame is `system.connected`.
      const res = await app.request(
        `/api/events/stream?sessionId=${SESSION_ID}&topics=state&lastEventId=3`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const frames = await drain(reader, { deadlineMs: 400 });

      const connected = frames.find((f) => f.event === "system.connected");
      expect(connected).toBeDefined();
      // The cursor-reset guard: connected frame must NOT carry an id.
      expect(connected!.id).toBeUndefined();

      // Nothing missed -> no replayed event frames.
      const eventFrames = frames.filter((f) => !isSystemFrame(f));
      expect(eventFrames).toHaveLength(0);

      await reader.cancel().catch(() => {});
    } finally {
      ac.abort();
    }
  });

  it("Bug A: an event emitted during replay is delivered exactly once", async () => {
    // Seed enough missed events that the replay loop blocks on consumer
    // backpressure — this suspends the producer mid-replay, which is exactly
    // the window the old code left without a live listener registered.
    const MISSED = 10;
    for (let n = 1; n <= MISSED; n++) emitSeq(eventBus, "state", n);

    const ac = new AbortController();
    try {
      const res = await app.request(
        `/api/events/stream?sessionId=${SESSION_ID}&topics=state&lastEventId=0`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();

      let emitted = false;
      const frames = await drain(reader, {
        deadlineMs: 2000,
        want: MISSED + 1, // 10 replayed + 1 live
        onFrame: (frame) => {
          // Fire the live event the moment we see the connected frame — the
          // producer is now provably past onEmit registration but still
          // suspended inside the replay loop (blocked on our reads).
          if (frame.event === "system.connected" && !emitted) {
            emitted = true;
            emitSeq(eventBus, "state", MISSED + 1); // id "11"
          }
        },
      });

      const eventFrames = frames.filter((f) => !isSystemFrame(f));
      const ids = eventFrames.map((f) => f.id);
      // Exactly once: no loss (id "11" present) and no duplicates.
      expect(new Set(ids).size).toBe(ids.length);
      const expectedIds = Array.from({ length: MISSED + 1 }, (_, i) =>
        String(i + 1),
      );
      expect([...ids].sort((a, b) => Number(a) - Number(b))).toEqual(
        expectedIds,
      );

      await reader.cancel().catch(() => {});
    } finally {
      ac.abort();
    }
  });
});
