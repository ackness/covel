import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createPgStore } from "@covel/store/postgres";
import { createPgAdvisorySessionLock } from "../../src/lib/pg-session-lock.js";
import { createIsolatedPgDatabase } from "./pg-test-db.js";
import { advanceFixture, events, gate } from "../api/__helpers/auto-advance.js";
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
let database: Awaited<ReturnType<typeof createIsolatedPgDatabase>> | undefined;
try {
  database = await createIsolatedPgDatabase(
    process.env.DATABASE_URL ??
      "postgresql://covel:covel_dev@localhost:5432/covel",
    "covel_auto_advance_pg",
  );
} catch (cause) {
  if (process.env.COVEL_REQUIRE_PG_TESTS === "1")
    throw new Error("PostgreSQL is required for advancement tests", { cause });
}
afterAll(() => database?.cleanup());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe.skipIf(!database)("PostgreSQL advancement", () => {
  it("releases the advisory lock between committed rounds and stops without undoing prior stories", async () => {
    const store = await createPgStore(database!.url, { freshSchema: true });
    const reader = await createPgStore(database!.url);
    const pool = postgres(database!.url, { max: 2 });
    const lock = createPgAdvisorySessionLock(pool);
    const waiting = gate(),
      release = gate();
    const f = await advanceFixture({
      store,
      databaseUrl: database!.url,
      sessionLock: lock,
      prepare: async (builtin) => {
        await writeFile(
          join(builtin, "observer", "PLUGIN.md"),
          "---\nid: observer\ndescription: Settle probe\nruntime:\n  schedule: { stage: post-turn, detached: { settle: true, maxSettleWaitMs: 10000 } }\n  function: { handler: ./handler.mjs }\n  effects: { writes: [plugin-data:self:rounds] }\n---\n",
        );
      },
      limit: 4,
      yields: ["continue", "continue", "continue"],
    });
    const add = store.addTraceEvent.bind(store);
    vi.spyOn(store, "addTraceEvent").mockImplementation(async (event) => {
      await add(event);
      const progress = event.payload as { phase?: string; round?: number };
      if (event.type === "execution.advance" && progress.phase === "waiting") {
        // A separate connection can mutate settings while the request owns no lock.
        await lock.withLock(f.sessionId, async () => {
          await reader.updateSession(f.sessionId, {
            metadata: {
              ...(await reader.getSession(f.sessionId))?.metadata,
              autoAdvanceLimit: 1,
            },
          });
        });
        if (progress.round === 3) {
          waiting.resolve();
          await release.promise;
        }
      }
    });
    try {
      const result = f.post().then((response) => response.text());
      await waiting.promise;
      expect((await reader.getSession(f.sessionId))?.completedPlayerTurns).toBe(
        5,
      );
      expect(
        (await reader.getSession(f.sessionId))?.metadata?.autoAdvanceLimit,
      ).toBe(1);
      expect(
        (await reader.queryTurnResults(f.sessionId, {}))
          .filter((row) => row.origin !== "background")
          .every((row) => row.commitStatus === "committed"),
      ).toBe(true);
      const settledJobs = await reader.listPluginData(
        f.sessionId,
        "observer",
        "rounds",
      );
      expect(settledJobs.length).toBeGreaterThanOrEqual(2);
      expect(
        settledJobs.every(
          (row) => (row.value as { logicalTurn: number }).logicalTurn === 5,
        ),
      ).toBe(true);
      await f.stop();
      release.resolve();
      const stream = events(await result);
      expect(
        stream.filter((event) => event.type === "execution.round.completed"),
      ).toHaveLength(3);
      expect(
        stream.filter((event) => event.type === "execution.completed"),
      ).toHaveLength(1);
      expect(
        (await reader.listMessages(f.sessionId)).filter(
          (row) => row.role === "assistant",
        ),
      ).toHaveLength(3);
      expect(await f.status()).toMatchObject({ state: "completed" });
    } finally {
      release.resolve();
      await f.close();
      await reader.close();
      await store.close();
      await pool.end();
    }
  });
  it("admits new input after cancelling a generated round on PostgreSQL", async () => {
    const store = await createPgStore(database!.url);
    const pool = postgres(database!.url, { max: 2 });
    const running = gate();
    const f = await advanceFixture({
      store,
      databaseUrl: database!.url,
      sessionLock: createPgAdvisorySessionLock(pool),
      yields: ["continue", "continue", "user"],
      onGenerate: async (index, request) => {
        if (index !== 1) return;
        running.resolve();
        await new Promise<void>((_, reject) => {
          const abort = () => reject(new DOMException("Stopped", "AbortError"));
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });
    try {
      const old = f.post().then((response) => response.text());
      await running.promise;
      const newer = events(
        await (
          await f.post({ actions: [{ kind: "say", text: "Change course" }] })
        ).text(),
      );
      const previous = events(await old);
      expect(
        previous.filter((event) => event.type === "execution.advance").at(-1)
          ?.payload.reason,
      ).toBe("new-input");
      expect(
        newer.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect((await store.getSession(f.sessionId))?.completedPlayerTurns).toBe(
        6,
      );
      const turns = await store.queryTurnResults(f.sessionId, {});
      expect(
        turns.filter((turn) => turn.commitStatus === "committed"),
      ).toHaveLength(2);
      expect(
        turns.filter((turn) => turn.commitStatus === "pending"),
      ).toHaveLength(0);
      expect(
        (await store.listMessages(f.sessionId)).filter(
          (message) => message.role === "assistant",
        ),
      ).toHaveLength(2);
    } finally {
      await f.stop();
      await f.close();
      await store.close();
      await pool.end();
    }
  });
});
