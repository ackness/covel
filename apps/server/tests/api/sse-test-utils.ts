/**
 * Shared SSE test helpers for `/api/events/stream` route tests
 * (subscribe-replay.test.ts, subscribe-reset.test.ts).
 */

import { Hono } from "hono";
import type { EventBus } from "@covel/events";
import type { DataStore } from "@covel/store";
import { subscribeRoutes } from "../../src/routes/api/subscribe.js";

export interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

export function parseBlock(block: string): Frame {
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

export function isSystemFrame(f: Frame): boolean {
  return f.event === "system.connected" || f.event === "system.heartbeat";
}

/**
 * Drain SSE frames from a reader until `want` non-system frames have arrived
 * or the deadline elapses. `onFrame` fires for every parsed frame — used to
 * inject an emit mid-replay while the producer is suspended on our reads.
 */
export async function drain(
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

export function makeApp(store: DataStore, eventBus: EventBus): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("eventBus", eventBus);
    await next();
  });
  app.route("/api/events", subscribeRoutes);
  return app;
}

export async function seedSession(
  store: DataStore,
  sessionId: string,
): Promise<void> {
  await store.createSession({
    id: sessionId,
    worldId: null,
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    presetId: null,
    activePlugins: [],
    createdAt: new Date().toISOString(),
  });
}

export function emitSeq(
  eventBus: EventBus,
  sessionId: string,
  topic: string,
  n: number,
): void {
  eventBus.emit({
    id: `msg-${n}`,
    type: "event",
    topic,
    sessionId,
    timestamp: new Date().toISOString(),
    payload: { n },
  });
}
