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
 *
 * Cursors are `${epoch}:${seq}` wire ids (re-review H-05/H-06); these tests
 * use the session's current epoch so replay follows the normal (no-reset)
 * path. Reset behavior is covered in subscribe-reset.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Hono } from "hono";
import { createEventBus, type EventBus } from "@covel/events";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  drain,
  emitSeq,
  isSystemFrame,
  makeApp,
  seedSession,
} from "./sse-test-utils.js";

const SESSION_ID = "sess-replay";

describe("R-01 SSE reconnect + replay/live race", () => {
  let store: DataStore;
  let eventBus: EventBus;
  let app: Hono;

  beforeEach(async () => {
    store = createMemoryStore();
    eventBus = createEventBus();
    app = makeApp(store, eventBus);
    await seedSession(store, SESSION_ID);
  });

  it("Bug B: connected frame carries no id, so reconnect does not reset the cursor / no full replay when nothing missed", async () => {
    // Three events already in the buffer (seqs 1..3).
    for (let n = 1; n <= 3; n++) emitSeq(eventBus, SESSION_ID, "state", n);
    const epoch = eventBus.getEventsAfter(SESSION_ID, 3).epoch!;

    const ac = new AbortController();
    try {
      // Reconnect at the tip (seq 3, current epoch) — nothing is newer, so
      // replay must be empty and the only frame is `system.connected`.
      const res = await app.request(
        `/api/events/stream?sessionId=${SESSION_ID}&topics=state&lastEventId=${encodeURIComponent(`${epoch}:3`)}`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const frames = await drain(reader, { deadlineMs: 400 });

      const connected = frames.find((f) => f.event === "system.connected");
      expect(connected).toBeDefined();
      // The cursor-reset guard: connected frame must NOT carry an id.
      expect(connected!.id).toBeUndefined();

      // Nothing missed -> no replayed event frames, and no reset either.
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
    for (let n = 1; n <= MISSED; n++) emitSeq(eventBus, SESSION_ID, "state", n);
    const epoch = eventBus.getEventsAfter(SESSION_ID, MISSED).epoch!;

    const ac = new AbortController();
    try {
      const res = await app.request(
        `/api/events/stream?sessionId=${SESSION_ID}&topics=state&lastEventId=${encodeURIComponent(`${epoch}:0`)}`,
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
            emitSeq(eventBus, SESSION_ID, "state", MISSED + 1); // seq 11
          }
        },
      });

      const eventFrames = frames.filter((f) => !isSystemFrame(f));
      const ids = eventFrames.map((f) => f.id);
      // Exactly once: no loss (seq 11 present) and no duplicates.
      expect(new Set(ids).size).toBe(ids.length);
      const seqs = eventFrames
        .map((f) => Number(f.id!.split(":").pop()))
        .sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: MISSED + 1 }, (_, i) => i + 1));
      // Every wire id carries the session's epoch.
      for (const f of eventFrames) {
        expect(f.id!.startsWith(`${epoch}:`)).toBe(true);
      }

      await reader.cancel().catch(() => {});
    } finally {
      ac.abort();
    }
  });
});
