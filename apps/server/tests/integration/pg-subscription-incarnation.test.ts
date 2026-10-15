import { afterAll, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createPgStore } from "@covel/store/postgres";
import { createPgEventTransport } from "../../src/lib/pg-event-transport.js";
import {
  invalidateSessionEvents,
  sessionEventBus,
} from "../../src/routes/api/session/session-events.js";
import { makeSession } from "../../../../packages/store/src/contract/test-fixtures.js";
import { createIsolatedPgDatabase } from "./pg-test-db.js";
import { drain, makeApp } from "../api/sse-test-utils.js";

let database: Awaited<ReturnType<typeof createIsolatedPgDatabase>> | undefined;
try {
  database = await createIsolatedPgDatabase(
    process.env.DATABASE_URL ??
      "postgresql://covel:covel_dev@127.0.0.1:5432/covel",
    "covel_subscription_incarnation_pg",
  );
} catch (cause) {
  if (process.env.COVEL_REQUIRE_PG_TESTS === "1")
    throw new Error("PostgreSQL is required", { cause });
}
afterAll(() => database?.cleanup());

describe.skipIf(!database)("F-201 PostgreSQL subscription incarnation", () => {
  it("carries large tagged events, closes on remote deletion, and rejects an old producer after recreation", async () => {
    const store = await createPgStore(database!.url, { freshSchema: true });
    const sender = createEventBus(store, {
      transport: await createPgEventTransport(database!.url),
      requireSessionIncarnation: true,
      strictEmissions: true,
    });
    const receiver = createEventBus(store, {
      transport: await createPgEventTransport(database!.url),
      requireSessionIncarnation: true,
      strictEmissions: true,
    });
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      const old = makeSession({
        id: "same-id",
        metadata: { sessionIncarnationNonce: "old-pg" },
      });
      await store.createSession(old);
      const producer = sessionEventBus(sender, old);
      const app = makeApp(store, receiver);
      const open = async () => {
        const response = await app.request(
          "/api/events/stream?sessionId=same-id&topics=state",
        );
        const reader = response.body!.getReader();
        readers.push(reader);
        await reader.read();
        return reader;
      };
      const first = await open();
      const payload = { value: "x".repeat(10000) };
      const event = () => ({
        id: crypto.randomUUID(),
        type: "event" as const,
        topic: "state",
        sessionId: old.id,
        timestamp: new Date().toISOString(),
        payload,
      });
      producer.emit(event());
      const frames = await drain(first, { want: 1, deadlineMs: 3000 });
      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0]!.data!).payload).toEqual(payload);
      await sender.flush();
      await store.deleteSession(old.id);
      invalidateSessionEvents(sender, old);
      expect(await drain(first, { deadlineMs: 3000 })).toEqual([]);
      expect((await first.read()).done).toBe(true);
      await store.createSession({
        ...old,
        metadata: { sessionIncarnationNonce: "new-pg" },
      });
      const second = await open();
      // A different origin can publish late; the frozen old producer is never relabelled.
      const current = (await store.getSession(old.id))!;
      const reads = vi.spyOn(store, "getSession");
      producer.emit({ ...event(), payload: { value: "old-owner-secret" } });
      // Wait for the remote old frame's ownership recheck, then prove this
      // same stream can still deliver the new owner's content.
      await vi.waitFor(() => expect(reads).toHaveBeenCalled());
      reads.mockRestore();
      sessionEventBus(sender, current).emit({
        ...event(),
        payload: { value: "current-owner-content" },
      });
      const currentFrames = await drain(second, { want: 1, deadlineMs: 3000 });
      expect(currentFrames).toHaveLength(1);
      expect(currentFrames[0]?.data).toContain("current-owner-content");
      expect(JSON.stringify(currentFrames)).not.toContain("old-owner-secret");
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel()));
      await Promise.all([sender.close(), receiver.close()]);
      await store.close();
    }
  });
});
