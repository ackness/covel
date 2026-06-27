/**
 * Real-PostgreSQL integration tests for the migrated commit pipeline (bug6).
 *
 * `commitAll()` now runs the proposal chain inside `DataStore.withTransaction`
 * (scoped, pooled-connection transactions) instead of the old global
 * `beginTx/commitTx/rollbackTx` shim. These tests connect to a real PG and
 * assert the caller-level behavior the MemoryStore mock cannot prove:
 *
 *   1. A multi-proposal chain commits atomically (all rows durable).
 *   2. A real DB error mid-chain (duplicate message PK) rolls the WHOLE chain
 *      back — no message and no state-change rows survive.
 *   3. Two concurrent `commitAll` calls on different sessions both commit
 *      without serializing behind a shared begin/commit window.
 *
 * Skipped automatically when `DATABASE_URL` is not set or PG is unreachable —
 * matches `tests/integration/pg-session-lock.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Proposal } from "@covel/shared";
import type { DataStore, SessionRecord } from "@covel/store";
import { createPgStore } from "@covel/store";
import { createCommitPipeline } from "@covel/runtime";

const BASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const ISOLATED_DB = "covel_test_commit_pipeline_pg";

/** DROP+CREATE an isolated database so this file never clobbers other PG suites. */
async function createIsolatedPgUrl(): Promise<string | null> {
  try {
    const admin = postgres(BASE_URL, { max: 1, connect_timeout: 3 });
    try {
      await admin`SELECT 1`;
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${ISOLATED_DB}" WITH (FORCE)`,
      );
      await admin.unsafe(`CREATE DATABASE "${ISOLATED_DB}"`);
    } finally {
      await admin.end();
    }
    const url = new URL(BASE_URL);
    url.pathname = `/${ISOLATED_DB}`;
    return url.toString();
  } catch {
    return null;
  }
}

const isolatedUrl = await createIsolatedPgUrl();

const SOURCE = {
  pluginId: "pg-commit-test",
  runtimeId: "pg-commit-test",
} as const;

function makeProposal(
  type: Proposal["type"],
  payload: Record<string, unknown>,
  id: string,
  sessionId: string,
): Proposal {
  return {
    id,
    type,
    source: SOURCE,
    turnId: "turn-pg",
    sessionId,
    payload,
    timestamp: new Date().toISOString(),
  };
}

async function seedSession(store: DataStore, id: string): Promise<void> {
  const now = new Date().toISOString();
  const session: SessionRecord = {
    id,
    worldId: "pg-test",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "en",
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  };
  await store.createSession(session);
}

describe.skipIf(!isolatedUrl)("commit pipeline on real PG (bug6)", () => {
  let store: DataStore;

  beforeAll(async () => {
    store = await createPgStore(isolatedUrl!, { freshSchema: true });
  });

  afterAll(async () => {
    await store?.close();
  });

  it("commits a multi-proposal chain atomically", async () => {
    const sessionId = "pg-commit-ok";
    await seedSession(store, sessionId);
    const pipeline = createCommitPipeline(store);

    const results = await pipeline.commitAll([
      makeProposal(
        "narrative.append",
        { content: "ok 1", kind: "story" },
        "pg-ok-msg-1",
        sessionId,
      ),
      makeProposal(
        "state.patch",
        { table: "stats", field: "hp", value: 80 },
        "pg-ok-state-1",
        sessionId,
      ),
      makeProposal(
        "narrative.append",
        { content: "ok 2", kind: "story" },
        "pg-ok-msg-2",
        sessionId,
      ),
    ]);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.committed)).toBe(true);

    expect(await store.listMessages(sessionId)).toHaveLength(2);
    expect(await store.listStateChanges(sessionId, "stats", "hp")).toHaveLength(
      1,
    );
  });

  it("rolls back the whole chain when a later write throws (duplicate PK)", async () => {
    const sessionId = "pg-commit-rollback";
    await seedSession(store, sessionId);
    const pipeline = createCommitPipeline(store);

    // The second narrative re-uses the first message id. addMessage is a plain
    // INSERT (no upsert), so the duplicate PK throws a real PG unique
    // violation mid-chain — which must roll back the earlier message AND the
    // state-change write.
    await expect(
      pipeline.commitAll([
        makeProposal(
          "narrative.append",
          { content: "doomed 1", kind: "story" },
          "pg-dup-msg",
          sessionId,
        ),
        makeProposal(
          "state.patch",
          { table: "stats", field: "mp", value: 10 },
          "pg-dup-state",
          sessionId,
        ),
        makeProposal(
          "narrative.append",
          { content: "doomed 2", kind: "story" },
          "pg-dup-msg", // duplicate id → unique violation
          sessionId,
        ),
      ]),
    ).rejects.toThrow();

    // Nothing from the failed chain survives.
    expect(await store.listMessages(sessionId)).toHaveLength(0);
    expect(await store.listStateChanges(sessionId, "stats", "mp")).toHaveLength(
      0,
    );
  });

  it("runs two concurrent commitAll chains on different sessions", async () => {
    const sessionA = "pg-commit-concurrent-a";
    const sessionB = "pg-commit-concurrent-b";
    await seedSession(store, sessionA);
    await seedSession(store, sessionB);
    const pipeline = createCommitPipeline(store);

    const [resA, resB] = await Promise.all([
      pipeline.commitAll([
        makeProposal(
          "narrative.append",
          { content: "A", kind: "story" },
          "pg-conc-a-1",
          sessionA,
        ),
      ]),
      pipeline.commitAll([
        makeProposal(
          "narrative.append",
          { content: "B", kind: "story" },
          "pg-conc-b-1",
          sessionB,
        ),
      ]),
    ]);

    expect(resA[0].committed).toBe(true);
    expect(resB[0].committed).toBe(true);
    expect(await store.listMessages(sessionA)).toHaveLength(1);
    expect(await store.listMessages(sessionB)).toHaveLength(1);
  });
});
