/**
 * Seats on PostgreSQL: a session's seats survive the snapshot → fork route and
 * a browser checkpoint export → replace, on the real `jsonb` column.
 */

import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { Seat } from "@covel/shared";
import {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  type DataStore,
  type SnapshotRecord,
} from "@covel/store";
import { createPgStore } from "@covel/store/postgres";
import {
  makeSession,
  makeWorld,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import { SESSION_INCARNATION_KEY } from "../../src/routes/api/session/session-guard.js";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import { createIsolatedPgDatabase } from "./pg-test-db.js";

let database: Awaited<ReturnType<typeof createIsolatedPgDatabase>> | undefined;
try {
  database = await createIsolatedPgDatabase(
    process.env.DATABASE_URL ??
      "postgresql://covel:covel_dev@localhost:5432/covel",
    "covel_session_seats_pg",
  );
} catch (cause) {
  if (process.env.COVEL_REQUIRE_PG_TESTS === "1")
    throw new Error("PostgreSQL is required for session seat tests", {
      cause,
    });
}
afterAll(() => database?.cleanup());

const CREATED: Seat[] = [
  {
    id: "lead",
    controller: "human",
    role: "player",
    characters: ["char-ada", "char-lin"],
    currentCharacterId: "char-lin",
  },
  { id: "table", controller: "empty", role: "host", characters: "auto" },
];

describe.skipIf(!database)("PostgreSQL session seats", () => {
  let store: DataStore;
  let app: Pick<Hono, "request">;

  beforeEach(async () => {
    store = await createPgStore(database!.url, { freshSchema: true });
    await store.upsertWorld(makeWorld({ id: "world-1" }));
    await store.createSession(
      makeSession({
        id: "parent",
        seats: CREATED,
        metadata: { [SESSION_INCARNATION_KEY]: "synthetic-parent-incarnation" },
      }),
    );
    const routes = new Hono<{
      Variables: {
        store: DataStore;
        sessionLock: SessionLock;
        pluginRegistry: PluginRegistry;
      };
    }>();
    const sessionLock = createInProcessSessionLock();
    routes.use("*", async (context, next) => {
      context.set("store", store);
      context.set("pluginRegistry", createPluginRegistry());
      context.set("sessionLock", sessionLock);
      await next();
    });
    routes.route("/api/sessions", snapshotRoutes);
    app = routes;
  });

  afterEach(async () => {
    await store.close();
  });

  it("creates, forks and restores a checkpoint with the stored seats", async () => {
    expect((await store.getSession("parent"))?.seats).toEqual(CREATED);

    const captured = await app.request("/api/sessions/parent/snapshots", {
      method: "POST",
    });
    expect(captured.status).toBe(201);
    const snapshot = (await captured.json()) as SnapshotRecord;
    expect(snapshot.payload.session.seats).toEqual(CREATED);
    expect(
      (await store.getSnapshot(snapshot.id))?.payload.session.seats,
    ).toEqual(CREATED);

    // The parent moves on; the fork restores what the snapshot captured.
    await store.updateSession("parent", {
      seats: [{ ...CREATED[0]!, currentCharacterId: "char-ada" }],
    });
    const forked = await app.request("/api/sessions/parent/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSnapshotId: snapshot.id }),
    });
    expect(forked.status).toBe(201);
    const { sessionId: childId } = (await forked.json()) as {
      sessionId: string;
    };
    expect((await store.getSession(childId))?.seats).toEqual(CREATED);

    const checkpoint = await exportSessionCheckpoint(store, childId, {
      revision: 1,
      actionId: "pg-seats-transfer",
    });
    expect(checkpoint.session.seats).toEqual(CREATED);
    await store.updateSession(childId, {
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
    });
    await replaceSessionFromCheckpoint(store, checkpoint);
    expect((await store.getSession(childId))?.seats).toEqual(CREATED);
  });
});
