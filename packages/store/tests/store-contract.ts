/**
 * DataStore contract test suite.
 *
 * Validates that any DataStore implementation correctly fulfills
 * the interface contract. Run against each backend to ensure
 * behavioral consistency.
 *
 * Usage:
 *   runDataStoreContractTests("MyStore", async () => ({
 *     store: new MyStore(),
 *     cleanup: async () => { ... },
 *   }));
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type {
  DataStore,
  WorldRecord,
  SessionRecord,
  MessageRecord,
  CharacterRecord,
  EventRecord,
  DomainRecord,
  SnapshotRecord,
} from "../src/types.js";

// ── Test Fixture Factories ───────────────────────────────────────

let counter = 0;

/** Generate a unique ID with the given prefix. */
function uid(prefix: string): string {
  return `${prefix}_${++counter}_${Math.random().toString(36).slice(2, 6)}`;
}

function createTestWorld(overrides?: Partial<WorldRecord>): WorldRecord {
  return {
    id: uid("world"),
    name: "Test World",
    description: "A world used in contract tests",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestSession(
  worldId: string,
  overrides?: Partial<SessionRecord>,
): SessionRecord {
  return {
    id: uid("sess"),
    worldId,
    status: "active",
    phase: "init",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestMessage(
  sessionId: string,
  overrides?: Partial<MessageRecord>,
): MessageRecord {
  return {
    id: uid("msg"),
    sessionId,
    role: "user",
    content: "Hello from contract test",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestCharacter(
  worldId: string,
  overrides?: Partial<CharacterRecord>,
): CharacterRecord {
  return {
    id: uid("char"),
    worldId,
    name: "Test Character",
    type: "player",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestEvent(
  branchId: string,
  overrides?: Partial<EventRecord>,
): EventRecord {
  return {
    id: uid("evt"),
    branchId,
    turnId: "turn_1",
    type: "test_event",
    source: "contract-test",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestRecord(
  branchId: string,
  overrides?: Partial<DomainRecord>,
): DomainRecord {
  return {
    id: uid("rec"),
    branchId,
    kind: "quest",
    key: "main_quest",
    value: { progress: 50 },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestSnapshot(
  branchId: string,
  overrides?: Partial<SnapshotRecord>,
): SnapshotRecord {
  return {
    id: uid("snap"),
    branchId,
    turnId: "turn_1",
    data: { state: "saved" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Contract Test Suite ──────────────────────────────────────────

export interface ContractTestFactory {
  store: DataStore;
  cleanup?: () => Promise<void>;
}

export function runDataStoreContractTests(
  name: string,
  factory: () => Promise<ContractTestFactory>,
): void {
  describe(`DataStore contract: ${name}`, () => {
    let store: DataStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const result = await factory();
      store = result.store;
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      await cleanup?.();
    });

    // ── World CRUD ─────────────────────────────────────────────

    describe("World operations", () => {
      it("upsertWorld + getWorld returns the inserted world", async () => {
        const world = createTestWorld({
          lore: "Ancient lands",
          tags: ["fantasy", "dark"],
        });
        await store.upsertWorld(world);

        const fetched = await store.getWorld(world.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.id).toBe(world.id);
        expect(fetched!.name).toBe(world.name);
        expect(fetched!.description).toBe(world.description);
        expect(fetched!.createdAt).toBe(world.createdAt);
      });

      it("upsertWorld overwrites fields on update (same ID)", async () => {
        const world = createTestWorld();
        await store.upsertWorld(world);

        const updated = { ...world, name: "Updated Name", description: "New desc" };
        await store.upsertWorld(updated);

        const fetched = await store.getWorld(world.id);
        expect(fetched!.name).toBe("Updated Name");
        expect(fetched!.description).toBe("New desc");

        // Should not create a duplicate
        const all = await store.listWorlds();
        expect(all).toHaveLength(1);
      });

      it("listWorlds returns all worlds", async () => {
        const w1 = createTestWorld({ name: "World A" });
        const w2 = createTestWorld({ name: "World B" });
        const w3 = createTestWorld({ name: "World C" });
        await store.upsertWorld(w1);
        await store.upsertWorld(w2);
        await store.upsertWorld(w3);

        const all = await store.listWorlds();
        expect(all).toHaveLength(3);

        const ids = all.map((w) => w.id);
        expect(ids).toContain(w1.id);
        expect(ids).toContain(w2.id);
        expect(ids).toContain(w3.id);
      });

      it("listWorlds returns empty array when no worlds exist", async () => {
        const all = await store.listWorlds();
        expect(all).toEqual([]);
      });

      it("deleteWorld removes the world", async () => {
        const world = createTestWorld();
        await store.upsertWorld(world);
        await store.deleteWorld(world.id);

        const fetched = await store.getWorld(world.id);
        expect(fetched).toBeNull();

        const all = await store.listWorlds();
        expect(all).toHaveLength(0);
      });

      it("deleteWorld is a no-op for non-existent ID", async () => {
        // Should not throw
        await store.deleteWorld("nonexistent");
      });

      it("getWorld returns null for non-existent ID", async () => {
        const fetched = await store.getWorld("nonexistent_id");
        expect(fetched).toBeNull();
      });

      it("preserves optional fields (lore, tags)", async () => {
        const world = createTestWorld({
          lore: "Long ago...",
          tags: ["medieval", "magic"],
        });
        await store.upsertWorld(world);

        const fetched = await store.getWorld(world.id);
        expect(fetched!.lore).toBe("Long ago...");
        expect(fetched!.tags).toEqual(["medieval", "magic"]);
      });

      it("handles world without optional fields", async () => {
        const world = createTestWorld(); // no lore, no tags
        await store.upsertWorld(world);

        const fetched = await store.getWorld(world.id);
        expect(fetched).not.toBeNull();
        // Optional fields should be absent or undefined/null
        expect(fetched!.lore ?? undefined).toBeUndefined();
        expect(fetched!.tags ?? undefined).toBeUndefined();
      });
    });

    // ── Session CRUD ───────────────────────────────────────────

    describe("Session operations", () => {
      it("upsertSession + getSession returns the inserted session", async () => {
        const session = createTestSession("world_1", {
          presetId: "default",
          settings: { difficulty: "hard" },
        });
        await store.upsertSession(session);

        const fetched = await store.getSession(session.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.id).toBe(session.id);
        expect(fetched!.worldId).toBe("world_1");
        expect(fetched!.status).toBe("active");
        expect(fetched!.phase).toBe("init");
      });

      it("listSessions filtered by worldId returns only matching sessions", async () => {
        const s1 = createTestSession("world_a");
        const s2 = createTestSession("world_b");
        const s3 = createTestSession("world_a");
        await store.upsertSession(s1);
        await store.upsertSession(s2);
        await store.upsertSession(s3);

        const worldA = await store.listSessions("world_a");
        expect(worldA).toHaveLength(2);
        expect(worldA.every((s) => s.worldId === "world_a")).toBe(true);

        const worldB = await store.listSessions("world_b");
        expect(worldB).toHaveLength(1);
      });

      it("listSessions without filter returns all sessions", async () => {
        const s1 = createTestSession("world_x");
        const s2 = createTestSession("world_y");
        await store.upsertSession(s1);
        await store.upsertSession(s2);

        const all = await store.listSessions();
        expect(all).toHaveLength(2);
      });

      it("listSessions returns empty array when no sessions exist", async () => {
        const all = await store.listSessions();
        expect(all).toEqual([]);
      });

      it("upsertSession updates existing session (same ID)", async () => {
        const session = createTestSession("world_1");
        await store.upsertSession(session);

        const updated = {
          ...session,
          phase: "playing" as const,
          status: "waiting_for_input" as const,
        };
        await store.upsertSession(updated);

        const fetched = await store.getSession(session.id);
        expect(fetched!.phase).toBe("playing");
        expect(fetched!.status).toBe("waiting_for_input");

        const all = await store.listSessions();
        expect(all).toHaveLength(1);
      });

      it("deleteSession removes the session", async () => {
        const session = createTestSession("world_1");
        await store.upsertSession(session);
        await store.deleteSession(session.id);

        expect(await store.getSession(session.id)).toBeNull();
      });

      it("getSession returns null for non-existent ID", async () => {
        expect(await store.getSession("nonexistent")).toBeNull();
      });

      it("preserves optional presetId and settings", async () => {
        const session = createTestSession("w1", {
          presetId: "preset-abc",
          settings: { theme: "dark", maxTurns: 100 },
        });
        await store.upsertSession(session);

        const fetched = await store.getSession(session.id);
        expect(fetched!.presetId).toBe("preset-abc");
        expect(fetched!.settings).toEqual({ theme: "dark", maxTurns: 100 });
      });
    });

    // ── Message operations ─────────────────────────────────────

    describe("Message operations", () => {
      it("addMessage + listMessages returns messages for the session", async () => {
        const m1 = createTestMessage("sess_1", { content: "Hello" });
        const m2 = createTestMessage("sess_1", {
          role: "assistant",
          content: "Hi there",
        });
        await store.addMessage(m1);
        await store.addMessage(m2);

        const msgs = await store.listMessages("sess_1");
        expect(msgs).toHaveLength(2);

        const ids = msgs.map((m) => m.id);
        expect(ids).toContain(m1.id);
        expect(ids).toContain(m2.id);
      });

      it("listMessages returns empty array for unknown sessionId", async () => {
        const msgs = await store.listMessages("nonexistent_session");
        expect(msgs).toEqual([]);
      });

      it("listMessages isolates messages by sessionId", async () => {
        await store.addMessage(createTestMessage("sess_a", { content: "A1" }));
        await store.addMessage(createTestMessage("sess_a", { content: "A2" }));
        await store.addMessage(createTestMessage("sess_b", { content: "B1" }));

        const sessA = await store.listMessages("sess_a");
        expect(sessA).toHaveLength(2);

        const sessB = await store.listMessages("sess_b");
        expect(sessB).toHaveLength(1);
      });

      it("clearMessages removes all messages for the given session only", async () => {
        await store.addMessage(createTestMessage("sess_a", { content: "msg1" }));
        await store.addMessage(createTestMessage("sess_a", { content: "msg2" }));
        await store.addMessage(createTestMessage("sess_b", { content: "msg3" }));

        await store.clearMessages("sess_a");

        expect(await store.listMessages("sess_a")).toHaveLength(0);
        expect(await store.listMessages("sess_b")).toHaveLength(1);
      });

      it("clearMessages is a no-op for unknown session", async () => {
        // Should not throw
        await store.clearMessages("nonexistent");
      });

      it("preserves message metadata", async () => {
        const msg = createTestMessage("sess_1", {
          metadata: { turnId: "t1", blocks: [1, 2, 3] },
        });
        await store.addMessage(msg);

        const msgs = await store.listMessages("sess_1");
        expect(msgs[0].metadata).toEqual({ turnId: "t1", blocks: [1, 2, 3] });
      });

      it("preserves kind in metadata (DataService round-trip pattern)", async () => {
        // This mirrors how LocalDataService stores messages:
        // kind, turnId, runtimeId, and block are packed into metadata.
        const storyMsg = createTestMessage("sess_kind", {
          role: "assistant",
          content: "The dragon roars...",
          metadata: { turnId: "t1", runtimeId: "rt-narrator", kind: "story" },
        });
        const pluginMsg = createTestMessage("sess_kind", {
          role: "assistant",
          content: "combat tracked",
          metadata: { turnId: "t1", runtimeId: "rt-combat", kind: "plugin" },
        });
        const blockMsg = createTestMessage("sess_kind", {
          role: "assistant",
          content: "",
          metadata: {
            turnId: "t1",
            block: { type: "choice_set", data: { options: ["flee", "fight"] } },
          },
        });
        const userMsg = createTestMessage("sess_kind", {
          role: "user",
          content: "I attack",
        });

        await store.addMessage(storyMsg);
        await store.addMessage(pluginMsg);
        await store.addMessage(blockMsg);
        await store.addMessage(userMsg);

        const msgs = await store.listMessages("sess_kind");
        expect(msgs).toHaveLength(4);

        const story = msgs.find((m) => m.id === storyMsg.id)!;
        const plugin = msgs.find((m) => m.id === pluginMsg.id)!;
        const block = msgs.find((m) => m.id === blockMsg.id)!;
        const user = msgs.find((m) => m.id === userMsg.id)!;

        // kind round-trips through metadata
        expect((story.metadata as Record<string, unknown>)?.kind).toBe("story");
        expect((plugin.metadata as Record<string, unknown>)?.kind).toBe("plugin");
        // block round-trips through metadata
        expect((block.metadata as Record<string, unknown>)?.block).toEqual({
          type: "choice_set", data: { options: ["flee", "fight"] },
        });
        // user message has no metadata
        expect(user.metadata).toBeUndefined();
      });

      it("stores all role variants (system, user, assistant)", async () => {
        const m1 = createTestMessage("sess_1", { role: "system", content: "System" });
        const m2 = createTestMessage("sess_1", { role: "user", content: "User" });
        const m3 = createTestMessage("sess_1", { role: "assistant", content: "Assistant" });
        await store.addMessage(m1);
        await store.addMessage(m2);
        await store.addMessage(m3);

        const msgs = await store.listMessages("sess_1");
        const roles = msgs.map((m) => m.role).sort();
        expect(roles).toEqual(["assistant", "system", "user"]);
      });
    });

    // ── Character operations ───────────────────────────────────

    describe("Character operations", () => {
      it("upsertCharacter + listCharacters returns the character", async () => {
        const char = createTestCharacter("w1", {
          sessionId: "sess_1",
          description: "A brave warrior",
          fields: { hp: 100, class: "warrior" },
          extensions: { custom: true },
        });
        await store.upsertCharacter(char);

        const chars = await store.listCharacters("sess_1");
        expect(chars).toHaveLength(1);
        expect(chars[0].name).toBe("Test Character");
        expect(chars[0].fields).toEqual({ hp: 100, class: "warrior" });
        expect(chars[0].extensions).toEqual({ custom: true });
      });

      it("listCharacters filtered by sessionId", async () => {
        await store.upsertCharacter(createTestCharacter("w1", { sessionId: "s1" }));
        await store.upsertCharacter(createTestCharacter("w1", { sessionId: "s1" }));
        await store.upsertCharacter(createTestCharacter("w1", { sessionId: "s2" }));

        const s1Chars = await store.listCharacters("s1");
        expect(s1Chars).toHaveLength(2);

        const s2Chars = await store.listCharacters("s2");
        expect(s2Chars).toHaveLength(1);
      });

      it("listCharacters without filter returns all characters", async () => {
        await store.upsertCharacter(createTestCharacter("w1", { sessionId: "s1" }));
        await store.upsertCharacter(createTestCharacter("w1", { sessionId: "s2" }));
        await store.upsertCharacter(createTestCharacter("w2"));

        const all = await store.listCharacters();
        expect(all).toHaveLength(3);
      });

      it("upsertCharacter updates existing character (same ID)", async () => {
        const char = createTestCharacter("w1");
        await store.upsertCharacter(char);

        const updated = { ...char, name: "Updated Hero", version: 2 };
        await store.upsertCharacter(updated);

        const all = await store.listCharacters();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe("Updated Hero");
        expect(all[0].version).toBe(2);
      });

      it("deleteCharacter removes the character", async () => {
        const char = createTestCharacter("w1");
        await store.upsertCharacter(char);
        await store.deleteCharacter(char.id);

        const all = await store.listCharacters();
        expect(all).toHaveLength(0);
      });

      it("deleteCharacter is a no-op for non-existent ID", async () => {
        await store.deleteCharacter("nonexistent");
      });

      it("preserves all character type variants", async () => {
        const c1 = createTestCharacter("w1", { type: "player" });
        const c2 = createTestCharacter("w1", { type: "npc" });
        const c3 = createTestCharacter("w1", { type: "companion" });
        await store.upsertCharacter(c1);
        await store.upsertCharacter(c2);
        await store.upsertCharacter(c3);

        const all = await store.listCharacters();
        const types = all.map((c) => c.type).sort();
        expect(types).toEqual(["companion", "npc", "player"]);
      });

      it("handles complex nested fields", async () => {
        const char = createTestCharacter("w1", {
          fields: {
            stats: { str: 10, dex: 15, int: 12 },
            inventory: [
              { name: "Sword", damage: 5 },
              { name: "Shield", armor: 3 },
            ],
            nested: { deep: { value: true } },
          },
        });
        await store.upsertCharacter(char);

        const chars = await store.listCharacters();
        expect(chars[0].fields).toEqual(char.fields);
      });
    });

    // ── Event operations ───────────────────────────────────────

    describe("Event operations", () => {
      it("appendEvent + listEvents returns events for the branch", async () => {
        const e1 = createTestEvent("branch_1", { type: "combat_start" });
        const e2 = createTestEvent("branch_1", {
          type: "combat_end",
          payload: { winner: "player" },
        });
        await store.appendEvent(e1);
        await store.appendEvent(e2);

        const events = await store.listEvents("branch_1");
        expect(events).toHaveLength(2);

        const ids = events.map((e) => e.id);
        expect(ids).toContain(e1.id);
        expect(ids).toContain(e2.id);
      });

      it("listEvents returns empty array for unknown branchId", async () => {
        const events = await store.listEvents("nonexistent_branch");
        expect(events).toEqual([]);
      });

      it("different branches are isolated", async () => {
        await store.appendEvent(createTestEvent("branch_a", { type: "event_a" }));
        await store.appendEvent(createTestEvent("branch_a", { type: "event_a2" }));
        await store.appendEvent(createTestEvent("branch_b", { type: "event_b" }));

        const branchA = await store.listEvents("branch_a");
        expect(branchA).toHaveLength(2);

        const branchB = await store.listEvents("branch_b");
        expect(branchB).toHaveLength(1);
        expect(branchB[0].type).toBe("event_b");
      });

      it("preserves locale and payload", async () => {
        const evt = createTestEvent("b1", {
          locale: "zh-CN",
          payload: { damage: 50, target: "goblin" },
        });
        await store.appendEvent(evt);

        const events = await store.listEvents("b1");
        expect(events[0].locale).toBe("zh-CN");
        expect(events[0].payload).toEqual({ damage: 50, target: "goblin" });
      });

      it("handles multiple events with same branch and different turns", async () => {
        const e1 = createTestEvent("branch_1", { turnId: "turn_1" });
        const e2 = createTestEvent("branch_1", { turnId: "turn_2" });
        const e3 = createTestEvent("branch_1", { turnId: "turn_3" });
        await store.appendEvent(e1);
        await store.appendEvent(e2);
        await store.appendEvent(e3);

        const events = await store.listEvents("branch_1");
        expect(events).toHaveLength(3);

        const turnIds = events.map((e) => e.turnId);
        expect(turnIds).toContain("turn_1");
        expect(turnIds).toContain("turn_2");
        expect(turnIds).toContain("turn_3");
      });
    });

    // ── Record operations ──────────────────────────────────────

    describe("Record operations", () => {
      it("upsertRecord + listRecords returns records for the branch", async () => {
        const r1 = createTestRecord("b1", { kind: "quest", key: "q1" });
        const r2 = createTestRecord("b1", { kind: "npc", key: "n1" });
        await store.upsertRecord(r1);
        await store.upsertRecord(r2);

        const all = await store.listRecords("b1");
        expect(all).toHaveLength(2);
      });

      it("listRecords filtered by kind returns only matching records", async () => {
        const r1 = createTestRecord("b1", { kind: "quest", key: "q1" });
        const r2 = createTestRecord("b1", { kind: "npc", key: "n1" });
        const r3 = createTestRecord("b1", { kind: "quest", key: "q2" });
        await store.upsertRecord(r1);
        await store.upsertRecord(r2);
        await store.upsertRecord(r3);

        const quests = await store.listRecords("b1", "quest");
        expect(quests).toHaveLength(2);
        expect(quests.every((r) => r.kind === "quest")).toBe(true);

        const npcs = await store.listRecords("b1", "npc");
        expect(npcs).toHaveLength(1);
      });

      it("listRecords returns empty array for unknown branch", async () => {
        const records = await store.listRecords("nonexistent");
        expect(records).toEqual([]);
      });

      it("upsertRecord updates existing record (same ID)", async () => {
        const rec = createTestRecord("b1");
        await store.upsertRecord(rec);

        const updated = {
          ...rec,
          value: { progress: 100 },
          summary: "Complete",
        };
        await store.upsertRecord(updated);

        const records = await store.listRecords("b1");
        expect(records).toHaveLength(1);
        expect(records[0].value).toEqual({ progress: 100 });
        expect(records[0].summary).toBe("Complete");
      });

      it("records on different branches are isolated", async () => {
        await store.upsertRecord(createTestRecord("b1", { kind: "quest" }));
        await store.upsertRecord(createTestRecord("b2", { kind: "quest" }));

        const b1 = await store.listRecords("b1");
        expect(b1).toHaveLength(1);

        const b2 = await store.listRecords("b2");
        expect(b2).toHaveLength(1);
      });

      it("preserves locale and summary", async () => {
        const rec = createTestRecord("b1", {
          summary: "Main quest progress",
          locale: "en-US",
        });
        await store.upsertRecord(rec);

        const records = await store.listRecords("b1");
        expect(records[0].summary).toBe("Main quest progress");
        expect(records[0].locale).toBe("en-US");
      });
    });

    // ── Snapshot operations ────────────────────────────────────

    describe("Snapshot operations", () => {
      it("createSnapshot + getSnapshot returns the snapshot by ID", async () => {
        const snap = createTestSnapshot("b1", {
          label: "Save Point 1",
          summary: "Before boss fight",
          data: { hp: 100, inventory: ["sword"] },
        });
        await store.createSnapshot(snap);

        const fetched = await store.getSnapshot(snap.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.id).toBe(snap.id);
        expect(fetched!.branchId).toBe("b1");
        expect(fetched!.label).toBe("Save Point 1");
        expect(fetched!.summary).toBe("Before boss fight");
        expect(fetched!.data).toEqual({ hp: 100, inventory: ["sword"] });
      });

      it("listSnapshots by branchId returns only matching snapshots", async () => {
        await store.createSnapshot(createTestSnapshot("b1"));
        await store.createSnapshot(createTestSnapshot("b1"));
        await store.createSnapshot(createTestSnapshot("b2"));

        const b1Snaps = await store.listSnapshots("b1");
        expect(b1Snaps).toHaveLength(2);

        const b2Snaps = await store.listSnapshots("b2");
        expect(b2Snaps).toHaveLength(1);
      });

      it("listSnapshots returns empty array for unknown branch", async () => {
        const snaps = await store.listSnapshots("nonexistent");
        expect(snaps).toEqual([]);
      });

      it("getSnapshot returns null for non-existent ID", async () => {
        expect(await store.getSnapshot("nonexistent")).toBeNull();
      });

      it("preserves complex data payloads", async () => {
        const snap = createTestSnapshot("b1", {
          data: {
            characters: [{ id: "c1", hp: 100 }],
            worldState: { weather: "rain", time: "night" },
            nested: { deep: { array: [1, 2, 3] } },
          },
        });
        await store.createSnapshot(snap);

        const fetched = await store.getSnapshot(snap.id);
        expect(fetched!.data).toEqual(snap.data);
      });
    });

    // ── Bulk operations ────────────────────────────────────────

    describe("Bulk operations", () => {
      it("exportAll returns all data with correct envelope", async () => {
        const world = createTestWorld();
        const session = createTestSession(world.id);
        const msg = createTestMessage(session.id);
        const char = createTestCharacter(world.id, { sessionId: session.id });
        const evt = createTestEvent("branch_1");
        const rec = createTestRecord("branch_1");
        const snap = createTestSnapshot("branch_1");

        await store.upsertWorld(world);
        await store.upsertSession(session);
        await store.addMessage(msg);
        await store.upsertCharacter(char);
        await store.appendEvent(evt);
        await store.upsertRecord(rec);
        await store.createSnapshot(snap);

        const exported = await store.exportAll();
        expect(exported.version).toBe("covel-export/v1");
        expect(exported.exportedAt).toBeTruthy();
        expect(exported.data.worlds).toHaveLength(1);
        expect(exported.data.sessions).toHaveLength(1);
        expect(exported.data.messages).toHaveLength(1);
        expect(exported.data.characters).toHaveLength(1);
        expect(exported.data.events).toHaveLength(1);
        expect(exported.data.records).toHaveLength(1);
        expect(exported.data.snapshots).toHaveLength(1);
      });

      it("exportAll returns empty arrays when store is empty", async () => {
        const exported = await store.exportAll();
        expect(exported.version).toBe("covel-export/v1");
        expect(exported.data.worlds).toEqual([]);
        expect(exported.data.sessions).toEqual([]);
        expect(exported.data.messages).toEqual([]);
        expect(exported.data.characters).toEqual([]);
        expect(exported.data.events).toEqual([]);
        expect(exported.data.records).toEqual([]);
        expect(exported.data.snapshots).toEqual([]);
      });

      it("clear removes everything", async () => {
        await store.upsertWorld(createTestWorld());
        await store.upsertSession(createTestSession("w1"));
        await store.addMessage(createTestMessage("s1"));
        await store.upsertCharacter(createTestCharacter("w1"));
        await store.appendEvent(createTestEvent("b1"));
        await store.upsertRecord(createTestRecord("b1"));
        await store.createSnapshot(createTestSnapshot("b1"));

        await store.clear();

        expect(await store.listWorlds()).toHaveLength(0);
        expect(await store.listSessions()).toHaveLength(0);
        expect(await store.listMessages("s1")).toHaveLength(0);
        expect(await store.listCharacters()).toHaveLength(0);
        expect(await store.listEvents("b1")).toHaveLength(0);
        expect(await store.listRecords("b1")).toHaveLength(0);
        expect(await store.listSnapshots("b1")).toHaveLength(0);
      });

      it("clear on empty store does not throw", async () => {
        await store.clear();
      });

      it("importAll restores data from a snapshot", async () => {
        const world = createTestWorld();
        const session = createTestSession(world.id);
        const msg = createTestMessage(session.id);
        const char = createTestCharacter(world.id, { sessionId: session.id });
        const evt = createTestEvent("branch_1");
        const rec = createTestRecord("branch_1");
        const snap = createTestSnapshot("branch_1");

        await store.upsertWorld(world);
        await store.upsertSession(session);
        await store.addMessage(msg);
        await store.upsertCharacter(char);
        await store.appendEvent(evt);
        await store.upsertRecord(rec);
        await store.createSnapshot(snap);

        const exported = await store.exportAll();

        // Clear and verify empty
        await store.clear();
        expect(await store.listWorlds()).toHaveLength(0);

        // Import and verify restored
        await store.importAll(exported);

        expect(await store.listWorlds()).toHaveLength(1);
        expect(await store.listSessions()).toHaveLength(1);
        expect(await store.listMessages(session.id)).toHaveLength(1);
        expect(await store.listCharacters()).toHaveLength(1);
        expect(await store.listEvents("branch_1")).toHaveLength(1);
        expect(await store.listRecords("branch_1")).toHaveLength(1);
        expect(await store.listSnapshots("branch_1")).toHaveLength(1);
      });

      it("round-trip preserves data integrity", async () => {
        const world = createTestWorld({
          lore: "Deep lore",
          tags: ["epic", "fantasy"],
        });
        const session = createTestSession(world.id, {
          presetId: "custom",
          settings: { difficulty: "nightmare" },
        });
        const msg = createTestMessage(session.id, {
          role: "assistant",
          content: "Welcome, adventurer.",
          metadata: { turnId: "t1" },
        });
        const char = createTestCharacter(world.id, {
          sessionId: session.id,
          type: "npc",
          description: "A mysterious sage",
          fields: { level: 42 },
        });
        const evt = createTestEvent("branch_x", {
          locale: "en-US",
          payload: { key: "value" },
        });
        const rec = createTestRecord("branch_x", {
          kind: "location",
          key: "tavern",
          value: { name: "The Rusty Mug" },
          summary: "A cozy tavern",
        });
        const snap = createTestSnapshot("branch_x", {
          label: "Checkpoint",
          summary: "After intro",
          data: { progress: 10 },
        });

        await store.upsertWorld(world);
        await store.upsertSession(session);
        await store.addMessage(msg);
        await store.upsertCharacter(char);
        await store.appendEvent(evt);
        await store.upsertRecord(rec);
        await store.createSnapshot(snap);

        // Export -> clear -> import
        const exported = await store.exportAll();
        await store.clear();
        await store.importAll(exported);

        // Verify each entity survived the round-trip
        const fetchedWorld = await store.getWorld(world.id);
        expect(fetchedWorld!.name).toBe(world.name);

        const fetchedSession = await store.getSession(session.id);
        expect(fetchedSession!.phase).toBe("init");
        expect(fetchedSession!.settings).toEqual({ difficulty: "nightmare" });

        const fetchedMsgs = await store.listMessages(session.id);
        expect(fetchedMsgs).toHaveLength(1);
        expect(fetchedMsgs[0].content).toBe("Welcome, adventurer.");
        expect(fetchedMsgs[0].metadata).toEqual({ turnId: "t1" });

        const fetchedChars = await store.listCharacters(session.id);
        expect(fetchedChars).toHaveLength(1);
        expect(fetchedChars[0].description).toBe("A mysterious sage");

        const fetchedEvents = await store.listEvents("branch_x");
        expect(fetchedEvents).toHaveLength(1);
        expect(fetchedEvents[0].payload).toEqual({ key: "value" });

        const fetchedRecords = await store.listRecords("branch_x");
        expect(fetchedRecords).toHaveLength(1);
        expect(fetchedRecords[0].value).toEqual({ name: "The Rusty Mug" });

        const fetchedSnap = await store.getSnapshot(snap.id);
        expect(fetchedSnap!.label).toBe("Checkpoint");
        expect(fetchedSnap!.data).toEqual({ progress: 10 });
      });

      it("importAll clears existing data before importing", async () => {
        // Pre-populate with some data
        await store.upsertWorld(createTestWorld({ name: "Old World" }));
        await store.upsertWorld(createTestWorld({ name: "Another Old World" }));

        // Create a snapshot with different data
        const newWorld = createTestWorld({ name: "Imported World" });
        const snapshot = {
          version: "covel-export/v1" as const,
          exportedAt: new Date().toISOString(),
          data: {
            worlds: [newWorld],
            sessions: [],
            messages: [],
            characters: [],
            events: [],
            records: [],
            snapshots: [],
          },
          config: {},
        };

        await store.importAll(snapshot);

        const worlds = await store.listWorlds();
        expect(worlds).toHaveLength(1);
        expect(worlds[0].name).toBe("Imported World");
      });
    });

    // ── Edge Cases & Cross-Cutting ─────────────────────────────

    describe("Edge cases", () => {
      it("handles concurrent writes without data loss", async () => {
        const worlds = Array.from({ length: 20 }, (_, i) =>
          createTestWorld({ id: `concurrent_${i}`, name: `World ${i}` }),
        );
        await Promise.all(worlds.map((w) => store.upsertWorld(w)));

        const all = await store.listWorlds();
        expect(all).toHaveLength(20);
      });

      it("handles empty string values", async () => {
        const world = createTestWorld({ name: "", description: "" });
        await store.upsertWorld(world);

        const fetched = await store.getWorld(world.id);
        expect(fetched!.name).toBe("");
        expect(fetched!.description).toBe("");
      });

      it("handles unicode content", async () => {
        const world = createTestWorld({
          name: "Dragon's Lair",
          description: "Where dragons dwell",
          lore: "An ancient place of power",
        });
        await store.upsertWorld(world);

        const fetched = await store.getWorld(world.id);
        expect(fetched!.name).toBe("Dragon's Lair");
        expect(fetched!.description).toBe("Where dragons dwell");
      });

      it("handles special characters in content", async () => {
        const msg = createTestMessage("sess_1", {
          content: 'Line 1\nLine 2\t"quoted"\n<html>&amp;</html>',
        });
        await store.addMessage(msg);

        const msgs = await store.listMessages("sess_1");
        expect(msgs[0].content).toBe(
          'Line 1\nLine 2\t"quoted"\n<html>&amp;</html>',
        );
      });

      it("handles large JSONB payloads", async () => {
        const largePayload: Record<string, unknown> = {};
        for (let i = 0; i < 100; i++) {
          largePayload[`key_${i}`] = {
            value: i,
            nested: { data: Array.from({ length: 10 }, (_, j) => j) },
          };
        }
        const rec = createTestRecord("b1", { value: largePayload });
        await store.upsertRecord(rec);

        const records = await store.listRecords("b1");
        expect(records[0].value).toEqual(largePayload);
      });
    });
  });
}
