/**
 * The history and snapshot reads that run on every turn use an index that
 * already holds their order (F-032, F-046), so a long session is not sorted
 * in a temporary B-tree on each read.
 *
 * The SQL comes from the real record modules: every statement they prepare is
 * recorded, then asked for its SQLite query plan.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTables } from "../src/sqlite/sqlite-schema-ddl.js";
import * as sqliteSchema from "../src/sqlite/schema.js";
import { drizzleNodeSqlite } from "../src/sqlite/drizzle-node-sqlite.js";
import { createSqliteSessionRecords } from "../src/sqlite/sqlite-session-records.js";
import { createSqliteSnapshotRecords } from "../src/sqlite/sqlite-snapshot-records.js";
import {
  makeSnapshot,
  makeTurnMessage,
} from "../src/contract/test-fixtures.js";

const SESSION = "long-session";

describe("SQLite query plans of the per-turn history and snapshot reads", () => {
  let db: DatabaseSync;
  let prepared: string[];
  let journal: ReturnType<typeof createSqliteSessionRecords>;
  let snapshots: ReturnType<typeof createSqliteSnapshotRecords>;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    createTables(db);
    prepared = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((source: string) => {
      prepared.push(source);
      return prepare(source);
    }) as typeof db.prepare;
    const drizzleDb = drizzleNodeSqlite(db, sqliteSchema);
    journal = createSqliteSessionRecords(drizzleDb);
    snapshots = createSqliteSnapshotRecords(drizzleDb);

    for (let turn = 0; turn < 200; turn += 1) {
      for (const sessionId of [SESSION, "other-session"]) {
        await journal.appendTurnMessage(
          makeTurnMessage({
            id: `${sessionId}-${turn}`,
            sessionId,
            turnId: `turn-${turn}`,
            sourceType: turn % 2 === 0 ? "player" : "runtime",
            createdAt: new Date(turn * 1000).toISOString(),
          }),
        );
      }
    }
    await journal.tagTurnMessagesCompacted(
      SESSION,
      Array.from({ length: 150 }, (_, turn) => `${SESSION}-${turn}`),
      "summary-1",
    );
    for (let index = 0; index < 20; index += 1) {
      await snapshots.saveSnapshot(
        makeSnapshot({
          id: `snap-${index}`,
          sessionId: SESSION,
          kind: "auto",
          createdAt: new Date(index * 1000).toISOString(),
        }),
      );
    }
  });

  afterEach(() => {
    db.close();
  });

  /** The plan of the last statement `run` prepared, with its parameters. */
  async function planOf(
    run: () => Promise<unknown>,
    params: readonly SQLInputValue[],
  ): Promise<string> {
    prepared = [];
    await run();
    const statement = prepared.at(-1);
    if (statement === undefined) throw new Error("no statement was prepared");
    const rows = db
      .prepare(`EXPLAIN QUERY PLAN ${statement}`)
      .all(...params) as Array<{ detail: string }>;
    return rows.map((row) => row.detail).join("\n");
  }

  it("reads the uncompacted history through the partial index, already ordered", async () => {
    expect(await journal.listUncompactedTurnMessages(SESSION)).toHaveLength(50);
    const plan = await planOf(
      () => journal.listUncompactedTurnMessages(SESSION),
      [SESSION],
    );
    expect(plan).toMatch(/turn_messages_uncompacted_idx/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it("reads the full history and its tail through the order index", async () => {
    for (const [run, params] of [
      [() => journal.listTurnMessages(SESSION), [SESSION]],
      [() => journal.listRecentTurnMessages(SESSION, 20), [SESSION, 20]],
    ] as const) {
      const plan = await planOf(run, params);
      expect(plan).toMatch(/turn_messages_session_order_idx/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
    expect(
      (await journal.listRecentTurnMessages(SESSION, 2)).map((m) => m.id),
    ).toEqual([`${SESSION}-198`, `${SESSION}-199`]);
  });

  it("counts the player's messages from the index alone", async () => {
    expect(await journal.getTurnMessageStats(SESSION)).toEqual({
      playerMessageCount: 100,
    });
    const plan = await planOf(
      () => journal.getTurnMessageStats(SESSION),
      [SESSION, "player"],
    );
    expect(plan).toMatch(/COVERING INDEX turn_messages_source_type_idx/);
  });

  it("prunes auto snapshots in one statement, checking fork parents through the parent index", async () => {
    expect(await snapshots.pruneAutoSnapshots(SESSION, 5)).toBe(15);
    expect((await snapshots.listSnapshots(SESSION)).map((s) => s.id)).toEqual([
      "snap-15",
      "snap-16",
      "snap-17",
      "snap-18",
      "snap-19",
    ]);
    prepared = [];
    await snapshots.pruneAutoSnapshots(SESSION, 2);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatch(/^delete from "state_snapshots"/);
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${prepared[0]!}`)
      .all(SESSION, "auto", SESSION, "auto", 2) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toMatch(/state_snapshots_parent_id_idx/);
    expect(details).toMatch(/state_snapshots_session_created_idx/);
    expect(details).not.toMatch(/SCAN (state_snapshots|child)\b(?! USING)/);
  });
});
