import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgStore } from "../src/postgres/pg-store.js";
import type {
  WorldRecord,
  SessionRecord,
  MessageRecord,
  CharacterRecord,
  EventRecord,
  DomainRecord,
  SnapshotRecord,
} from "../src/types.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://covel:covel_dev@localhost:5432/covel";

let store: PgStore;

beforeAll(async () => {
  store = new PgStore({ databaseUrl: DATABASE_URL });
  await store.initialize();
  await store.clear();
});

afterAll(async () => {
  await store.clear();
  await store.close();
});

beforeEach(async () => {
  await store.clear();
});

// ── Test Fixtures ─────────────────────────────────────────────────

function makeWorld(overrides?: Partial<WorldRecord>): WorldRecord {
  return {
    id: `world_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: "Test World",
    description: "A test world",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSession(worldId: string, overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    worldId,
    status: "active",
    phase: "init",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMessage(sessionId: string, overrides?: Partial<MessageRecord>): MessageRecord {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sessionId,
    role: "user",
    content: "Hello",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCharacter(worldId: string, overrides?: Partial<CharacterRecord>): CharacterRecord {
  return {
    id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    worldId,
    name: "Test Character",
    type: "player",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(branchId: string, overrides?: Partial<EventRecord>): EventRecord {
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    branchId,
    turnId: "turn_1",
    type: "test_event",
    source: "test",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDomainRecord(branchId: string, overrides?: Partial<DomainRecord>): DomainRecord {
  return {
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    branchId,
    kind: "quest",
    key: "main_quest",
    value: { progress: 50 },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSnapshot(branchId: string, overrides?: Partial<SnapshotRecord>): SnapshotRecord {
  return {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    branchId,
    turnId: "turn_1",
    data: { state: "saved" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── World Tests ───────────────────────────────────────────────────

describe("PgStore — Worlds", () => {
  it("should list empty worlds", async () => {
    const worlds = await store.listWorlds();
    expect(worlds).toEqual([]);
  });

  it("should upsert and get a world", async () => {
    const world = makeWorld({ lore: "Ancient lands", tags: ["fantasy", "dark"] });
    await store.upsertWorld(world);

    const fetched = await store.getWorld(world.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(world.id);
    expect(fetched!.name).toBe(world.name);
    expect(fetched!.lore).toBe("Ancient lands");
    expect(fetched!.tags).toEqual(["fantasy", "dark"]);
  });

  it("should update an existing world via upsert", async () => {
    const world = makeWorld();
    await store.upsertWorld(world);
    await store.upsertWorld({ ...world, name: "Updated World" });

    const fetched = await store.getWorld(world.id);
    expect(fetched!.name).toBe("Updated World");

    const all = await store.listWorlds();
    expect(all).toHaveLength(1);
  });

  it("should delete a world", async () => {
    const world = makeWorld();
    await store.upsertWorld(world);
    await store.deleteWorld(world.id);

    const fetched = await store.getWorld(world.id);
    expect(fetched).toBeNull();
  });

  it("should return null for non-existent world", async () => {
    const fetched = await store.getWorld("nonexistent");
    expect(fetched).toBeNull();
  });
});

// ── Session Tests ─────────────────────────────────────────────────

describe("PgStore — Sessions", () => {
  it("should list empty sessions", async () => {
    const sessions = await store.listSessions();
    expect(sessions).toEqual([]);
  });

  it("should upsert and get a session", async () => {
    const session = makeSession("world_1", { presetId: "default", settings: { difficulty: "hard" } });
    await store.upsertSession(session);

    const fetched = await store.getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.worldId).toBe("world_1");
    expect(fetched!.presetId).toBe("default");
    expect(fetched!.settings).toEqual({ difficulty: "hard" });
  });

  it("should filter sessions by worldId", async () => {
    const s1 = makeSession("world_a");
    const s2 = makeSession("world_b");
    const s3 = makeSession("world_a");
    await Promise.all([
      store.upsertSession(s1),
      store.upsertSession(s2),
      store.upsertSession(s3),
    ]);

    const worldA = await store.listSessions("world_a");
    expect(worldA).toHaveLength(2);

    const all = await store.listSessions();
    expect(all).toHaveLength(3);
  });

  it("should update session via upsert", async () => {
    const session = makeSession("world_1");
    await store.upsertSession(session);
    await store.upsertSession({ ...session, phase: "playing", status: "waiting_for_input" });

    const fetched = await store.getSession(session.id);
    expect(fetched!.phase).toBe("playing");
    expect(fetched!.status).toBe("waiting_for_input");
  });

  it("should delete a session", async () => {
    const session = makeSession("world_1");
    await store.upsertSession(session);
    await store.deleteSession(session.id);

    expect(await store.getSession(session.id)).toBeNull();
  });
});

// ── Message Tests ─────────────────────────────────────────────────

describe("PgStore — Messages", () => {
  it("should add and list messages", async () => {
    const m1 = makeMessage("sess_1", { content: "Hello" });
    const m2 = makeMessage("sess_1", { role: "assistant", content: "Hi there" });
    const m3 = makeMessage("sess_2", { content: "Other session" });

    await store.addMessage(m1);
    await store.addMessage(m2);
    await store.addMessage(m3);

    const msgs = await store.listMessages("sess_1");
    expect(msgs).toHaveLength(2);
  });

  it("should clear messages for a session", async () => {
    await store.addMessage(makeMessage("sess_a", { content: "msg1" }));
    await store.addMessage(makeMessage("sess_a", { content: "msg2" }));
    await store.addMessage(makeMessage("sess_b", { content: "msg3" }));

    await store.clearMessages("sess_a");

    expect(await store.listMessages("sess_a")).toHaveLength(0);
    expect(await store.listMessages("sess_b")).toHaveLength(1);
  });

  it("should store metadata", async () => {
    const msg = makeMessage("sess_1", { metadata: { turnId: "t1", blocks: [1, 2] } });
    await store.addMessage(msg);

    const msgs = await store.listMessages("sess_1");
    expect(msgs[0].metadata).toEqual({ turnId: "t1", blocks: [1, 2] });
  });
});

// ── Character Tests ───────────────────────────────────────────────

describe("PgStore — Characters", () => {
  it("should upsert and list characters", async () => {
    const char = makeCharacter("world_1", {
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
  });

  it("should list all characters without filter", async () => {
    await store.upsertCharacter(makeCharacter("w1", { sessionId: "s1" }));
    await store.upsertCharacter(makeCharacter("w1", { sessionId: "s2" }));

    const all = await store.listCharacters();
    expect(all).toHaveLength(2);
  });

  it("should update character via upsert", async () => {
    const char = makeCharacter("w1");
    await store.upsertCharacter(char);
    await store.upsertCharacter({ ...char, name: "Updated Name", version: 2 });

    const all = await store.listCharacters();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Updated Name");
    expect(all[0].version).toBe(2);
  });

  it("should delete a character", async () => {
    const char = makeCharacter("w1");
    await store.upsertCharacter(char);
    await store.deleteCharacter(char.id);

    const all = await store.listCharacters();
    expect(all).toHaveLength(0);
  });
});

// ── Event Tests ───────────────────────────────────────────────────

describe("PgStore — Events", () => {
  it("should append and list events", async () => {
    const e1 = makeEvent("branch_1", { type: "combat_start" });
    const e2 = makeEvent("branch_1", { type: "combat_end", payload: { winner: "player" } });
    const e3 = makeEvent("branch_2", { type: "other" });

    await store.appendEvent(e1);
    await store.appendEvent(e2);
    await store.appendEvent(e3);

    const branch1Events = await store.listEvents("branch_1");
    expect(branch1Events).toHaveLength(2);

    const branch2Events = await store.listEvents("branch_2");
    expect(branch2Events).toHaveLength(1);
    expect(branch2Events[0].type).toBe("other");
  });

  it("should store locale and payload", async () => {
    const evt = makeEvent("b1", {
      locale: "zh-CN",
      payload: { damage: 50, target: "goblin" },
    });
    await store.appendEvent(evt);

    const events = await store.listEvents("b1");
    expect(events[0].locale).toBe("zh-CN");
    expect(events[0].payload).toEqual({ damage: 50, target: "goblin" });
  });
});

// ── Domain Record Tests ───────────────────────────────────────────

describe("PgStore — Domain Records", () => {
  it("should upsert and list records", async () => {
    const r1 = makeDomainRecord("b1", { kind: "quest", key: "q1" });
    const r2 = makeDomainRecord("b1", { kind: "npc", key: "n1" });
    const r3 = makeDomainRecord("b2", { kind: "quest", key: "q2" });

    await store.upsertRecord(r1);
    await store.upsertRecord(r2);
    await store.upsertRecord(r3);

    const allB1 = await store.listRecords("b1");
    expect(allB1).toHaveLength(2);

    const questsB1 = await store.listRecords("b1", "quest");
    expect(questsB1).toHaveLength(1);
    expect(questsB1[0].key).toBe("q1");
  });

  it("should update record via upsert", async () => {
    const rec = makeDomainRecord("b1");
    await store.upsertRecord(rec);
    await store.upsertRecord({ ...rec, value: { progress: 100 }, summary: "Complete" });

    const records = await store.listRecords("b1");
    expect(records).toHaveLength(1);
    expect(records[0].value).toEqual({ progress: 100 });
    expect(records[0].summary).toBe("Complete");
  });
});

// ── Snapshot Tests ────────────────────────────────────────────────

describe("PgStore — Snapshots", () => {
  it("should create and get snapshot", async () => {
    const snap = makeSnapshot("b1", {
      label: "Save Point 1",
      summary: "Before boss fight",
      data: { hp: 100, inventory: ["sword"] },
    });
    await store.createSnapshot(snap);

    const fetched = await store.getSnapshot(snap.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.label).toBe("Save Point 1");
    expect(fetched!.data).toEqual({ hp: 100, inventory: ["sword"] });
  });

  it("should list snapshots by branch", async () => {
    await store.createSnapshot(makeSnapshot("b1"));
    await store.createSnapshot(makeSnapshot("b1"));
    await store.createSnapshot(makeSnapshot("b2"));

    const b1Snaps = await store.listSnapshots("b1");
    expect(b1Snaps).toHaveLength(2);

    const b2Snaps = await store.listSnapshots("b2");
    expect(b2Snaps).toHaveLength(1);
  });

  it("should return null for non-existent snapshot", async () => {
    expect(await store.getSnapshot("nonexistent")).toBeNull();
  });
});

// ── Bulk Operations ───────────────────────────────────────────────

describe("PgStore — Bulk Operations", () => {
  it("should export and import all data", async () => {
    // Populate
    const world = makeWorld();
    const session = makeSession(world.id);
    const msg = makeMessage(session.id);
    const char = makeCharacter(world.id, { sessionId: session.id });
    const evt = makeEvent("branch_1");
    const rec = makeDomainRecord("branch_1");
    const snap = makeSnapshot("branch_1");

    await store.upsertWorld(world);
    await store.upsertSession(session);
    await store.addMessage(msg);
    await store.upsertCharacter(char);
    await store.appendEvent(evt);
    await store.upsertRecord(rec);
    await store.createSnapshot(snap);

    // Export
    const exported = await store.exportAll();
    expect(exported.version).toBe("covel-export/v1");
    expect(exported.data.worlds).toHaveLength(1);
    expect(exported.data.sessions).toHaveLength(1);
    expect(exported.data.messages).toHaveLength(1);
    expect(exported.data.characters).toHaveLength(1);
    expect(exported.data.events).toHaveLength(1);
    expect(exported.data.records).toHaveLength(1);
    expect(exported.data.snapshots).toHaveLength(1);

    // Clear and verify empty
    await store.clear();
    expect(await store.listWorlds()).toHaveLength(0);

    // Import and verify
    await store.importAll(exported);
    expect(await store.listWorlds()).toHaveLength(1);
    expect(await store.listSessions()).toHaveLength(1);
    expect(await store.listMessages(session.id)).toHaveLength(1);
    expect(await store.listCharacters()).toHaveLength(1);
    expect(await store.listEvents("branch_1")).toHaveLength(1);
    expect(await store.listRecords("branch_1")).toHaveLength(1);
    expect(await store.listSnapshots("branch_1")).toHaveLength(1);
  });

  it("should clear all data", async () => {
    await store.upsertWorld(makeWorld());
    await store.upsertSession(makeSession("w1"));
    await store.addMessage(makeMessage("s1"));

    await store.clear();

    expect(await store.listWorlds()).toHaveLength(0);
    expect(await store.listSessions()).toHaveLength(0);
    expect(await store.listMessages("s1")).toHaveLength(0);
  });
});

// ── Edge Cases ────────────────────────────────────────────────────

describe("PgStore — Edge Cases", () => {
  it("should handle optional fields being undefined", async () => {
    const world = makeWorld(); // no lore, no tags
    await store.upsertWorld(world);

    const fetched = await store.getWorld(world.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.lore).toBeUndefined();
    expect(fetched!.tags).toBeUndefined();
  });

  it("should handle JSONB with complex nested objects", async () => {
    const char = makeCharacter("w1", {
      fields: {
        stats: { str: 10, dex: 15, int: 12 },
        inventory: [{ name: "Sword", damage: 5 }, { name: "Shield", armor: 3 }],
        nested: { deep: { value: true } },
      },
    });
    await store.upsertCharacter(char);

    const chars = await store.listCharacters();
    expect(chars[0].fields).toEqual(char.fields);
  });

  it("should handle concurrent writes", async () => {
    const worlds = Array.from({ length: 20 }, (_, i) =>
      makeWorld({ id: `concurrent_${i}`, name: `World ${i}` }),
    );
    await Promise.all(worlds.map((w) => store.upsertWorld(w)));

    const all = await store.listWorlds();
    expect(all).toHaveLength(20);
  });
});
