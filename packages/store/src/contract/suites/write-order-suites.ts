import { beforeEach, describe, expect, it } from "vitest";
import type { DataStore, RecordChange } from "../../types.js";
import {
  makeCharacter,
  makeLorebookEntry,
  makeSession,
  makeTurnMessage,
  ts,
} from "../test-fixtures.js";

/**
 * The write order of a session (`common/write-order-ddl.ts`): turn messages and
 * record changes are numbered in the order they are saved, and a number is
 * never visible before a lower one of the same session.
 */
export function registerWriteOrderStoreSuites(getStore: () => DataStore): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  const pluginRow = (sessionId: string, key: string, text: string) => ({
    id: `${sessionId}:${key}`,
    sessionId,
    pluginId: "plugin-1",
    namespace: "facts",
    key,
    value: { text },
    createdAt: ts(),
    updatedAt: ts(),
  });
  const changes = (sessionId: string, after: number | null = null) =>
    store.listRecordChanges(sessionId, { after, limit: 100 });

  describe("record changes", () => {
    it("keeps one change per record, renumbered on every write and kept on delete", async () => {
      const sessionId = "sess-changes";
      await store.createSession(makeSession({ id: sessionId }));
      const entry = makeLorebookEntry({ id: "lore-1", sessionId });
      await store.upsertLorebookEntries([entry]);
      await store.upsertCharacter(makeCharacter({ id: "char-1", sessionId }));
      await store.setPluginData(pluginRow(sessionId, "fact-1", "one"));
      await store.setPluginDataBatch([
        pluginRow(sessionId, "fact-2", "two"),
        pluginRow(sessionId, "fact-3", "three"),
      ]);
      await store.setPluginData(pluginRow("sess-changes-other", "fact-1", "x"));

      const initial = await changes(sessionId);
      expect(initial).toEqual([
        { kind: "lorebook", owner: entry.owner, id: "lore-1", seq: 1 },
        { kind: "character", id: "char-1", seq: 2 },
        {
          kind: "plugin_data",
          pluginId: "plugin-1",
          namespace: "facts",
          key: "fact-1",
          seq: 3,
        },
        expect.objectContaining({ key: "fact-2", seq: 4 }),
        expect.objectContaining({ key: "fact-3", seq: 5 }),
      ]);

      // An update moves the record to the end; a delete stays as a change.
      await store.upsertLorebookEntries([{ ...entry, enabled: false }]);
      await store.deleteCharacter(sessionId, "char-1");
      await store.deletePluginData(sessionId, "plugin-1", "facts", "fact-2");
      // Deleting nothing changes nothing.
      await store.deleteCharacter(sessionId, "missing");
      await store.deleteLorebookEntry(sessionId, entry.owner, "missing");
      await store.deletePluginData(sessionId, "plugin-1", "facts", "missing");

      const after = await changes(sessionId, 5);
      expect(after).toEqual([
        { kind: "lorebook", owner: entry.owner, id: "lore-1", seq: 6 },
        { kind: "character", id: "char-1", seq: 7 },
        expect.objectContaining({ key: "fact-2", seq: 8 }),
      ]);
      expect(await store.getCharacter(sessionId, "char-1")).toBeNull();
      expect((await changes(sessionId)).map((c) => c.seq)).toEqual([
        3, 5, 6, 7, 8,
      ]);
    });

    it("filters by plugin data namespace, upper bound and limit", async () => {
      const sessionId = "sess-changes-filter";
      await store.createSession(makeSession({ id: sessionId }));
      await store.setPluginData(pluginRow(sessionId, "a", "a"));
      await store.setPluginData({
        ...pluginRow(sessionId, "b", "b"),
        namespace: "other",
      });
      await store.upsertCharacter(makeCharacter({ id: "c", sessionId }));
      await store.setPluginData(pluginRow(sessionId, "d", "d"));

      const facts = await store.listRecordChanges(sessionId, {
        after: null,
        pluginData: { pluginId: "plugin-1", namespace: "facts" },
        limit: 10,
      });
      expect(facts.map((c) => c.seq)).toEqual([1, 4]);
      const throughThree = await store.listRecordChanges(sessionId, {
        after: 1,
        through: 3,
        limit: 10,
      });
      expect(throughThree.map((c) => c.seq)).toEqual([2, 3]);
      expect(
        (await store.listRecordChanges(sessionId, { after: null, limit: 1 }))
          .length,
      ).toBe(1);
      expect(
        await store.listRecordChanges(sessionId, { after: null, limit: 0 }),
      ).toEqual([]);
    });

    it("rolls a change back with its write", async () => {
      const sessionId = "sess-changes-rollback";
      await store.createSession(makeSession({ id: sessionId }));
      await store.setPluginData(pluginRow(sessionId, "kept", "kept"));
      await expect(
        store.withTransaction(async (tx) => {
          await tx.setPluginData(pluginRow(sessionId, "dropped", "dropped"));
          await tx.upsertCharacter(makeCharacter({ sessionId }));
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      const kept: RecordChange[] = await changes(sessionId);
      expect(kept).toEqual([expect.objectContaining({ key: "kept", seq: 1 })]);
    });
  });

  describe("session write numbers", () => {
    it("starts again at 1 for a session deleted and created again", async () => {
      const sessionId = "sess-write-reset";
      await store.createSession(makeSession({ id: sessionId }));
      await store.appendTurnMessage(makeTurnMessage({ sessionId }));
      await store.setPluginData(pluginRow(sessionId, "fact", "fact"));
      await store.deleteSession(sessionId);

      await store.createSession(makeSession({ id: sessionId }));
      expect(await changes(sessionId)).toEqual([]);
      await store.appendTurnMessage(makeTurnMessage({ sessionId }));
      const [message] = await store.listTurnMessagesAfter(sessionId, null, 10);
      expect(message?.writeSeq).toBe(1);
    });

    it("never shows a number before a lower one that is still being saved", async () => {
      const sessionId = "sess-write-commit-order";
      await store.createSession(makeSession({ id: sessionId }));
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let taken!: () => void;
      const numberTaken = new Promise<void>((resolve) => {
        taken = resolve;
      });
      const slow = store.withTransaction(async (tx) => {
        await tx.appendTurnMessage(
          makeTurnMessage({ id: "slow", sessionId, createdAt: ts(10) }),
        );
        taken();
        await held;
      });
      await numberTaken;
      const fast = store.appendTurnMessage(
        makeTurnMessage({ id: "fast", sessionId, createdAt: ts(20) }),
      );
      const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
      await pause();
      // PostgreSQL answers this read while "slow" is still open; the
      // single-connection backends queue it behind the open transaction.
      const reading = store.listTurnMessagesAfter(sessionId, null, 10);
      await pause();
      release();
      await Promise.all([slow, fast]);

      // A reader must never see "fast" without "slow", which holds the lower
      // number: its cursor would then step over "slow" for good.
      const seen = (await reading).map((m) => m.id);
      expect([[], ["slow"], ["slow", "fast"]]).toContainEqual(seen);
      const all = await store.listTurnMessagesAfter(sessionId, null, 10);
      expect(all.map((m) => [m.id, m.writeSeq])).toEqual([
        ["slow", 1],
        ["fast", 2],
      ]);
    });
  });
}
