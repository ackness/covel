/**
 * `GET /api/sessions/:id/view` names the subscription cursor of the moment it
 * was read (F-060). A first subscription that connects with it receives every
 * event the view may not include, even when the stream registers after the
 * view was read.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createEventBus, type EventBus } from "@covel/events";
import { createPluginRegistry } from "@covel/plugin-loader";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { parseSubscriptionEventId, type SessionSnapshot } from "@covel/shared";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { subscribeRoutes } from "../../src/routes/api/subscribe.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  drain,
  emitSeq,
  isSystemFrame,
  seedSession,
} from "./sse-test-utils.js";

const SESSION_ID = "sess-view-cursor";

function makeApp(store: DataStore, eventBus: EventBus): Hono {
  const app = new Hono();
  const pluginRegistry = createPluginRegistry();
  const sessionLock = createInProcessSessionLock();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("eventBus", eventBus);
    c.set("pluginRegistry", pluginRegistry);
    c.set("sessionLock", sessionLock);
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/events", subscribeRoutes);
  return app;
}

async function readView(app: Hono): Promise<SessionSnapshot> {
  const res = await app.request(`/api/sessions/${SESSION_ID}/view`);
  expect(res.status).toBe(200);
  return (await res.json()) as SessionSnapshot;
}

async function replayFrom(app: Hono, cursor: string) {
  const ac = new AbortController();
  try {
    const res = await app.request(
      `/api/events/stream?sessionId=${SESSION_ID}&topics=state&lastEventId=${encodeURIComponent(cursor)}`,
      { signal: ac.signal },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const frames = await drain(reader, { deadlineMs: 400 });
    await reader.cancel().catch(() => {});
    return frames;
  } finally {
    ac.abort();
  }
}

describe("view event cursor", () => {
  let store: DataStore;
  let eventBus: EventBus;

  beforeEach(async () => {
    store = createMemoryStore();
    eventBus = createEventBus();
    await seedSession(store, SESSION_ID);
  });

  it("starts tracking an untracked session, so a stream opened later replays from the view", async () => {
    const app = makeApp(store, eventBus);
    const view = await readView(app);
    const cursor = parseSubscriptionEventId(view.eventCursor ?? "");
    expect(cursor).toMatchObject({ seq: 0 });

    // Published after the view was read, before the stream registered.
    emitSeq(eventBus, SESSION_ID, "state", 1);
    emitSeq(eventBus, SESSION_ID, "state", 2);

    const frames = await replayFrom(app, view.eventCursor!);
    expect(frames.some((f) => f.event === "system.reset")).toBe(false);
    expect(frames.filter((f) => !isSystemFrame(f)).map((f) => f.id)).toEqual([
      `${cursor!.epoch}:1`,
      `${cursor!.epoch}:2`,
    ]);
  });

  it("reads the cursor before the snapshot, so an event published during the read is replayed", async () => {
    emitSeq(eventBus, SESSION_ID, "state", 1);
    let published = false;
    const readingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "listMessagesPage")
          return async (...args: Parameters<DataStore["listMessagesPage"]>) => {
            if (!published) {
              published = true;
              emitSeq(eventBus, SESSION_ID, "state", 2);
            }
            return target.listMessagesPage(...args);
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const app = makeApp(readingStore, eventBus);
    const view = await readView(app);
    expect(published).toBe(true);
    const cursor = parseSubscriptionEventId(view.eventCursor ?? "");
    expect(cursor).toMatchObject({ seq: 1 });

    const frames = await replayFrom(app, view.eventCursor!);
    expect(frames.filter((f) => !isSystemFrame(f)).map((f) => f.id)).toEqual([
      `${cursor!.epoch}:2`,
    ]);
  });
});
