import { beforeEach, describe, expect, it } from "vitest";
import type {
  CharacterRecord,
  DataStore,
  StateEntryRecord,
} from "../../types.js";
import {
  id,
  makeApproval,
  makeCharacter,
  makeEvent,
  makeInteractionRecord,
  makeLorebookEntry,
  makeMessage,
  makePlayerInput,
  makeRuntimeOutput,
  makeRuntimeResult,
  makeSession,
  makeSessionSummary,
  makeSnapshot,
  makeSnapshotPayload,
  makeStateChange,
  makeStateEntry,
  makeStateSchema,
  makeSuspension,
  makeToolCall,
  makeTraceEvent,
  makeTurnMessage,
  makeTurnResult,
  makeWorkingMemory,
  makeWorld,
  makeWorldDataImportLedger,
  ts,
} from "../test-fixtures.js";

export function registerCoreStoreSuites(getStore: () => DataStore): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("Session", () => {
    it("should create and retrieve a session", async () => {
      const session = makeSession();
      await store.createSession(session);
      const result = await store.getSession(session.id);
      expect(result).toEqual(session);
    });

    it("should list all sessions", async () => {
      const s1 = makeSession();
      const s2 = makeSession();
      await store.createSession(s1);
      await store.createSession(s2);
      const list = await store.listSessions();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.id)).toContain(s1.id);
      expect(list.map((s) => s.id)).toContain(s2.id);
    });

    it("should update session status and turnCount", async () => {
      const session = makeSession({
        status: "active",
        turnCount: 0,
        preGameCompleted: [],
      });
      await store.createSession(session);
      const now = ts();
      await store.updateSession(session.id, {
        status: "ended",
        turnCount: 5,
        updatedAt: now,
      });
      const result = await store.getSession(session.id);
      expect(result?.status).toBe("ended");
      expect(result?.turnCount).toBe(5);
      expect(result?.updatedAt).toBe(now);
    });

    it("should delete a session", async () => {
      const session = makeSession();
      await store.createSession(session);
      await store.deleteSession(session.id);
      const result = await store.getSession(session.id);
      expect(result).toBeNull();
    });

    it("should return null for unknown session", async () => {
      const result = await store.getSession("nonexistent");
      expect(result).toBeNull();
    });

    it("PR-6: persists runtimeModelOverrides on create and update", async () => {
      const session = makeSession();
      await store.createSession({
        ...session,
        runtimeModelOverrides: {
          narrator: "balance",
          "codex/unlocker": "fast",
        },
      });

      const created = await store.getSession(session.id);
      expect(created?.runtimeModelOverrides).toEqual({
        narrator: "balance",
        "codex/unlocker": "fast",
      });

      await store.updateSession(session.id, {
        runtimeModelOverrides: { narrator: "fast" },
        updatedAt: ts(),
      });
      const updated = await store.getSession(session.id);
      expect(updated?.runtimeModelOverrides).toEqual({
        narrator: "fast",
      });
    });

    it("parity: updateSession persists locale across backends", async () => {
      // The player's live UI locale is persisted onto the session so
      // server-initiated turns (plugin-rpc / deferred followers) inherit it.
      // Every backend must round-trip a locale change identically.
      const session = makeSession({ locale: "zh-CN" });
      await store.createSession(session);
      expect((await store.getSession(session.id))?.locale).toBe("zh-CN");

      await store.updateSession(session.id, {
        locale: "en-US",
        updatedAt: ts(),
      });
      expect((await store.getSession(session.id))?.locale).toBe("en-US");
    });

    it("persists session metadata and presetId through create and update", async () => {
      const session = makeSession({
        presetId: "preset-a",
        metadata: {
          presetId: "preset-a",
          localOnly: true,
        },
      });
      await store.createSession(session);
      const created = await store.getSession(session.id);
      expect(created?.presetId).toBe("preset-a");
      expect(created?.metadata).toEqual({
        presetId: "preset-a",
        localOnly: true,
      });

      await store.updateSession(session.id, {
        presetId: "preset-b",
        updatedAt: ts(),
      });
      const updated = await store.getSession(session.id);
      expect(updated?.presetId).toBe("preset-b");
      expect(updated?.metadata).toMatchObject({
        presetId: "preset-b",
        localOnly: true,
      });

      await store.updateSession(session.id, {
        presetId: "preset-c",
        metadata: {
          mergedPatch: true,
        },
        updatedAt: ts(),
      });
      const merged = await store.getSession(session.id);
      expect(merged?.presetId).toBe("preset-c");
      expect(merged?.metadata).toEqual({
        presetId: "preset-c",
        localOnly: true,
        mergedPatch: true,
      });
    });

    it("parity: createSession with undefined runtimeModelOverrides reads back absent", async () => {
      // Backend-parity guard: an absent override map must round-trip as absent
      // on every backend. Legacy SQL writers coerced `undefined → {}` (inline
      // `JSON.stringify({})` / `?? {}`); the read mapper collapsed empty back to
      // undefined, but the storage-level coercion was inconsistent. Lock the
      // public contract: no overrides in → no overrides out.
      const session = makeSession({ runtimeModelOverrides: undefined });
      await store.createSession(session);
      const result = await store.getSession(session.id);
      expect(result?.runtimeModelOverrides).toBeUndefined();
    });

    it("parity: updateSession clearing runtimeModelOverrides to undefined reads back absent", async () => {
      const session = makeSession();
      await store.createSession({
        ...session,
        runtimeModelOverrides: { narrator: "fast" },
      });
      await store.updateSession(session.id, {
        runtimeModelOverrides: undefined,
        updatedAt: ts(),
      });
      const result = await store.getSession(session.id);
      expect(result?.runtimeModelOverrides).toBeUndefined();
    });

    it("PR-6: clearing runtimeModelOverrides with empty object removes it", async () => {
      const session = makeSession();
      await store.createSession({
        ...session,
        runtimeModelOverrides: { narrator: "fast" },
      });
      await store.updateSession(session.id, {
        runtimeModelOverrides: {},
        updatedAt: ts(),
      });
      const cleared = await store.getSession(session.id);
      expect(
        cleared?.runtimeModelOverrides === undefined ||
          Object.keys(cleared?.runtimeModelOverrides ?? {}).length === 0,
      ).toBe(true);
    });
  });

  describe("TurnResults", () => {
    it("should list turn results for a session ordered by createdAt", async () => {
      const tr1 = makeTurnResult({ sessionId: "sess-1", createdAt: ts(0) });
      const tr2 = makeTurnResult({ sessionId: "sess-1", createdAt: ts(100) });
      const tr3 = makeTurnResult({ sessionId: "other", createdAt: ts(50) });
      await store.saveTurnResult(tr1);
      await store.saveTurnResult(tr2);
      await store.saveTurnResult(tr3);
      const list = await store.listTurnResults("sess-1");
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(tr1.id);
      expect(list[1].id).toBe(tr2.id);
    });

    it("should respect limit parameter", async () => {
      const tr1 = makeTurnResult({ sessionId: "sess-1", createdAt: ts(0) });
      const tr2 = makeTurnResult({ sessionId: "sess-1", createdAt: ts(100) });
      await store.saveTurnResult(tr1);
      await store.saveTurnResult(tr2);
      const list = await store.listTurnResults("sess-1", 1);
      expect(list).toHaveLength(1);
    });
  });

  describe("RuntimeResults", () => {
    it("should save and list runtime results by sessionId+turnId", async () => {
      const rr = makeRuntimeResult({ sessionId: "sess-1", turnId: "turn-1" });
      await store.saveRuntimeResult(rr);
      const list = await store.listRuntimeResults("sess-1", "turn-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(rr);
    });

    it("should return empty array for unknown turnId", async () => {
      const list = await store.listRuntimeResults("sess-1", "unknown");
      expect(list).toEqual([]);
    });
  });

  describe("ToolCalls", () => {
    it("should save and list tool calls by sessionId", async () => {
      const tc = makeToolCall({ sessionId: "sess-1" });
      await store.saveToolCall(tc);
      const list = await store.listToolCalls("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(tc);
    });

    it("should filter by turnId when provided", async () => {
      const tc1 = makeToolCall({ sessionId: "sess-1", turnId: "turn-1" });
      const tc2 = makeToolCall({ sessionId: "sess-1", turnId: "turn-2" });
      await store.saveToolCall(tc1);
      await store.saveToolCall(tc2);
      const list = await store.listToolCalls("sess-1", "turn-1");
      expect(list).toHaveLength(1);
      expect(list[0].turnId).toBe("turn-1");
    });
  });

  describe("StateSchemas", () => {
    it("should save and list state schemas by sessionId", async () => {
      const schema = makeStateSchema({ sessionId: "sess-1" });
      await store.saveStateSchema(schema);
      const list = await store.listStateSchemas("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(schema);
    });

    it("should delete a state schema", async () => {
      const schema = makeStateSchema({
        sessionId: "sess-1",
        tableName: "stats",
      });
      await store.saveStateSchema(schema);
      await store.deleteStateSchema("sess-1", "stats");
      const list = await store.listStateSchemas("sess-1");
      expect(list).toHaveLength(0);
    });

    it("should return empty array for unknown session", async () => {
      const list = await store.listStateSchemas("unknown");
      expect(list).toEqual([]);
    });
  });

  describe("StateEntries", () => {
    it("should upsert and get a state entry", async () => {
      const entry = makeStateEntry({
        sessionId: "sess-1",
        tableName: "stats",
        fieldName: "hp",
      });
      await store.upsertStateEntry(entry);
      const result = await store.getStateEntry("sess-1", "stats", "hp");
      expect(result).toEqual(entry);
    });

    it("should preserve state entry null values", async () => {
      const entry = makeStateEntry({
        sessionId: "sess-state-null",
        tableName: "stats",
        fieldName: "hp",
        value: null,
      });
      await store.upsertStateEntry(entry);
      const result = await store.getStateEntry(
        "sess-state-null",
        "stats",
        "hp",
      );
      expect(result?.value).toBeNull();
    });

    it("should overwrite on second upsert", async () => {
      const entry1 = makeStateEntry({
        sessionId: "sess-1",
        tableName: "stats",
        fieldName: "hp",
        value: 100,
      });
      await store.upsertStateEntry(entry1);

      const entry2: StateEntryRecord = {
        ...entry1,
        value: 50,
        updatedAt: ts(100),
      };
      await store.upsertStateEntry(entry2);

      const result = await store.getStateEntry("sess-1", "stats", "hp");
      expect(result?.value).toBe(50);
    });

    it("should list all entries for a session+table", async () => {
      const e1 = makeStateEntry({
        sessionId: "sess-1",
        tableName: "stats",
        fieldName: "hp",
      });
      const e2 = makeStateEntry({
        sessionId: "sess-1",
        tableName: "stats",
        fieldName: "mp",
      });
      const e3 = makeStateEntry({
        sessionId: "sess-1",
        tableName: "other",
        fieldName: "x",
      });
      await store.upsertStateEntry(e1);
      await store.upsertStateEntry(e2);
      await store.upsertStateEntry(e3);
      const list = await store.listStateEntries("sess-1", "stats");
      expect(list).toHaveLength(2);
    });
  });

  describe("StateChanges", () => {
    it("should add and list state changes", async () => {
      const change = makeStateChange({
        sessionId: "sess-1",
        tableName: "stats",
        fieldName: "hp",
      });
      await store.addStateChange(change);
      const list = await store.listStateChanges("sess-1", "stats", "hp");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(change);
    });

    it("should preserve state change null values", async () => {
      const change = makeStateChange({
        sessionId: "sess-state-change-null",
        tableName: "stats",
        fieldName: "hp",
        value: null,
      });
      await store.addStateChange(change);
      const list = await store.listStateChanges(
        "sess-state-change-null",
        "stats",
        "hp",
      );
      expect(list).toHaveLength(1);
      expect(list[0].value).toBeNull();
    });

    it("should return changes ordered by createdAt", async () => {
      const c1 = makeStateChange({
        sessionId: "sess-1",
        tableName: "stats",
        fieldName: "hp",
        createdAt: ts(0),
      });
      const c2 = makeStateChange({
        sessionId: "sess-1",
        tableName: "stats",
        fieldName: "hp",
        createdAt: ts(100),
      });
      await store.addStateChange(c1);
      await store.addStateChange(c2);
      const list = await store.listStateChanges("sess-1", "stats", "hp");
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(c1.id);
      expect(list[1].id).toBe(c2.id);
    });
  });

  describe("Events", () => {
    it("should save and list events by sessionId", async () => {
      const event = makeEvent({ sessionId: "sess-1" });
      await store.saveEvent(event);
      const list = await store.listEvents("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(event);
    });

    it("should filter by topic when provided", async () => {
      const e1 = makeEvent({ sessionId: "sess-1", topic: "combat" });
      const e2 = makeEvent({ sessionId: "sess-1", topic: "quest" });
      await store.saveEvent(e1);
      await store.saveEvent(e2);
      const list = await store.listEvents("sess-1", { topic: "combat" });
      expect(list).toHaveLength(1);
      expect(list[0].topic).toBe("combat");
    });

    it("should fetch a single event by id scoped to its session", async () => {
      const event = makeEvent({ sessionId: "sess-1" });
      await store.saveEvent(event);
      expect(await store.getEventById("sess-1", event.id)).toEqual(event);
      // Wrong session scope and unknown id both miss.
      expect(await store.getEventById("sess-other", event.id)).toBeNull();
      expect(await store.getEventById("sess-1", "missing-id")).toBeNull();
    });
  });

  describe("Approvals", () => {
    it("should save and list approvals", async () => {
      const approval = makeApproval({ sessionId: "sess-1" });
      await store.saveApproval(approval);
      const list = await store.listApprovals("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(approval);
    });
  });

  describe("Messages", () => {
    it("should add and list messages", async () => {
      const msg = makeMessage({ sessionId: "sess-1" });
      await store.addMessage(msg);
      const list = await store.listMessages("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(msg);
    });

    it("should return messages ordered by createdAt", async () => {
      const m1 = makeMessage({ sessionId: "sess-1", createdAt: ts(0) });
      const m2 = makeMessage({ sessionId: "sess-1", createdAt: ts(100) });
      await store.addMessage(m1);
      await store.addMessage(m2);
      const list = await store.listMessages("sess-1");
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(m1.id);
      expect(list[1].id).toBe(m2.id);
    });

    it("listMessagesPage returns the newest window then pages older by cursor", async () => {
      const m1 = makeMessage({ sessionId: "sess-mp", createdAt: ts(10) });
      const m2 = makeMessage({ sessionId: "sess-mp", createdAt: ts(20) });
      const m3 = makeMessage({ sessionId: "sess-mp", createdAt: ts(30) });
      const m4 = makeMessage({ sessionId: "sess-mp", createdAt: ts(40) });
      // Insert out of order to prove the read path — not insertion order —
      // determines the window.
      await store.addMessage(m3);
      await store.addMessage(m1);
      await store.addMessage(m4);
      await store.addMessage(m2);

      // No cursor → newest 2, oldest-first.
      const newest = await store.listMessagesPage("sess-mp", { limit: 2 });
      expect(newest.map((m) => m.id)).toEqual([m3.id, m4.id]);

      // Page older than the oldest of the previous window.
      const older = await store.listMessagesPage("sess-mp", {
        limit: 2,
        before: { createdAt: newest[0].createdAt, id: newest[0].id },
      });
      expect(older.map((m) => m.id)).toEqual([m1.id, m2.id]);

      // Cursor before the very first message → empty.
      const none = await store.listMessagesPage("sess-mp", {
        limit: 5,
        before: { createdAt: m1.createdAt, id: m1.id },
      });
      expect(none).toEqual([]);
    });

    it("listMessagesPage keyset breaks createdAt ties by id (no skip/repeat)", async () => {
      // `messages` has no monotonic `order` column and same-turn proposals
      // routinely share a millisecond, so the cursor must fall back to id.
      const same = ts(50);
      const a = makeMessage({
        sessionId: "sess-tie",
        id: "id-a",
        createdAt: same,
      });
      const b = makeMessage({
        sessionId: "sess-tie",
        id: "id-b",
        createdAt: same,
      });
      const c = makeMessage({
        sessionId: "sess-tie",
        id: "id-c",
        createdAt: same,
      });
      await store.addMessage(b);
      await store.addMessage(c);
      await store.addMessage(a);

      const page1 = await store.listMessagesPage("sess-tie", { limit: 2 });
      expect(page1.map((m) => m.id)).toEqual(["id-b", "id-c"]);

      const page2 = await store.listMessagesPage("sess-tie", {
        limit: 2,
        before: { createdAt: page1[0].createdAt, id: page1[0].id },
      });
      expect(page2.map((m) => m.id)).toEqual(["id-a"]);
    });

    it("listMessagesPage returns [] for a non-positive limit", async () => {
      await store.addMessage(makeMessage({ sessionId: "sess-mp0" }));
      expect(await store.listMessagesPage("sess-mp0", { limit: 0 })).toEqual(
        [],
      );
      expect(await store.listMessagesPage("sess-mp0", { limit: -3 })).toEqual(
        [],
      );
    });
  });

  describe("Characters", () => {
    it("should upsert and list characters", async () => {
      const char = makeCharacter({ sessionId: "sess-1" });
      await store.upsertCharacter(char);
      const list = await store.listCharacters("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(char);
    });

    it("should overwrite character with same id", async () => {
      const charId = id();
      const char1 = makeCharacter({
        id: charId,
        sessionId: "sess-1",
        name: "Hero",
      });
      await store.upsertCharacter(char1);

      const char2: CharacterRecord = {
        ...char1,
        name: "Dark Hero",
        version: 2,
      };
      await store.upsertCharacter(char2);

      const list = await store.listCharacters("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("Dark Hero");
      expect(list[0].version).toBe(2);
    });

    it("deletes a character by sessionId and id", async () => {
      const char = makeCharacter({
        id: "char-delete",
        sessionId: "sess-characters-delete",
      });
      const other = makeCharacter({
        id: "char-keep",
        sessionId: "sess-characters-delete-other",
      });
      await store.upsertCharacter(char);
      await store.upsertCharacter(other);

      await store.deleteCharacter("sess-characters-delete", "char-delete");
      await store.deleteCharacter("sess-characters-delete", "char-keep");

      expect(await store.listCharacters("sess-characters-delete")).toEqual([]);
      expect(
        (await store.listCharacters("sess-characters-delete-other")).map(
          (r) => r.id,
        ),
      ).toEqual(["char-keep"]);
    });
  });
}
