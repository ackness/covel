/**
 * Integration test: PgServerStore
 *
 * Verifies that createPgServerStore works end-to-end against a real PG instance.
 * Requires: STORE_BACKEND=pg DATABASE_URL=postgresql://covel:covel_dev@localhost:5432/covel
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPgServerStore } from "../src/store/pg-server-store.js";
import type { ServerStore } from "../src/store/types.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://covel:covel_dev@localhost:5432/covel";

let store: ServerStore;
// Keep a reference to the underlying pg connection for cleanup
let pgSql: ReturnType<typeof import("postgres").default>;

beforeAll(async () => {
  const postgres = (await import("postgres")).default;
  pgSql = postgres(DATABASE_URL);

  // Clean server tables before test
  await pgSql`DROP TABLE IF EXISTS sv_characters CASCADE`;
  await pgSql`DROP TABLE IF EXISTS sv_messages CASCADE`;
  await pgSql`DROP TABLE IF EXISTS sv_sessions CASCADE`;
  await pgSql`DROP TABLE IF EXISTS sv_worlds CASCADE`;

  store = await createPgServerStore({ databaseUrl: DATABASE_URL });
});

afterAll(async () => {
  // Clean up
  await pgSql`DROP TABLE IF EXISTS sv_characters CASCADE`;
  await pgSql`DROP TABLE IF EXISTS sv_messages CASCADE`;
  await pgSql`DROP TABLE IF EXISTS sv_sessions CASCADE`;
  await pgSql`DROP TABLE IF EXISTS sv_worlds CASCADE`;
  await pgSql.end();
});

describe("PgServerStore — Worlds", () => {
  it("should seed worlds on first creation", () => {
    const worlds = store.listWorlds();
    expect(worlds.length).toBeGreaterThan(0);
  });

  it("should create and get a world", () => {
    const world = store.createWorld("Test World", "A test world", {
      lore: "Ancient lands",
      locale: "en-US",
      tags: ["test"],
    });
    expect(world.id).toBeTruthy();
    expect(world.name).toBe("Test World");

    const fetched = store.getWorld(world.id);
    expect(fetched).toBeDefined();
    expect(fetched!.lore).toBe("Ancient lands");
  });

  it("should update a world", () => {
    const world = store.createWorld("Original", "desc");
    const updated = store.updateWorld(world.id, { name: "Updated" });
    expect(updated!.name).toBe("Updated");
    expect(updated!.updatedAt).toBeTruthy();
  });

  it("should return undefined for non-existent world", () => {
    expect(store.getWorld("nonexistent")).toBeUndefined();
  });
});

describe("PgServerStore — Sessions", () => {
  it("should create and list sessions", () => {
    const world = store.createWorld("World for Sessions", "desc");
    const session = store.createSession({ worldId: world.id, presetId: "default" });
    expect(session.id).toBeTruthy();
    expect(session.worldId).toBe(world.id);
    expect(session.phase).toBe("init");

    const sessions = store.listSessions(world.id);
    expect(sessions.some((s) => s.id === session.id)).toBe(true);
  });

  it("should update session", () => {
    const world = store.createWorld("W", "d");
    const session = store.createSession({ worldId: world.id });
    const updated = store.updateSession(session.id, { phase: "playing", status: "waiting_for_input" });
    expect(updated!.phase).toBe("playing");
    expect(updated!.status).toBe("waiting_for_input");
  });

  it("should update session phase", () => {
    const world = store.createWorld("W", "d");
    const session = store.createSession({ worldId: world.id });
    const updated = store.updateSessionPhase(session.id, "character_creation");
    expect(updated!.phase).toBe("character_creation");
  });
});

describe("PgServerStore — Messages", () => {
  it("should add and list messages", () => {
    const world = store.createWorld("W", "d");
    const session = store.createSession({ worldId: world.id });

    store.addMessage(session.id, "user", "Hello");
    store.addMessage(session.id, "assistant", "Hi there", { turnId: "t1" });

    const msgs = store.listMessages(session.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].turnId).toBe("t1");
  });

  it("should store block metadata", () => {
    const world = store.createWorld("W", "d");
    const session = store.createSession({ worldId: world.id });

    store.addMessage(session.id, "assistant", "", {
      turnId: "t1",
      block: { type: "choice_set", data: { options: ["a", "b"] } },
    });

    const msgs = store.listMessages(session.id);
    expect(msgs[0].block).toEqual({ type: "choice_set", data: { options: ["a", "b"] } });
  });
});

describe("PgServerStore — Characters", () => {
  it("should create and get characters", () => {
    const world = store.createWorld("W", "d");
    const session = store.createSession({ worldId: world.id });

    const char = store.createCharacter(session.id, {
      name: "Hero",
      type: "player",
      description: "A brave warrior",
      fields: { hp: 100 },
    });

    expect(char.id).toBeTruthy();
    expect(char.name).toBe("Hero");
    expect(char.fields).toEqual({ hp: 100 });

    const fetched = store.getCharacter(char.id);
    expect(fetched!.name).toBe("Hero");

    const sessionChars = store.getSessionCharacters(session.id);
    expect(sessionChars).toHaveLength(1);
  });

  it("should update characters", () => {
    const world = store.createWorld("W", "d");
    const session = store.createSession({ worldId: world.id });
    const char = store.createCharacter(session.id, { name: "Hero" });

    const updated = store.updateCharacter(char.id, { name: "Updated Hero" });
    expect(updated!.name).toBe("Updated Hero");
    expect(updated!.version).toBe(2);
  });
});

describe("PgServerStore — State Patches (in-memory)", () => {
  it("should add and list state patches", () => {
    store.addStatePatch("sess-1", {
      id: "p1",
      summary: "HP changed",
      packageName: "core-combat",
      data: { hp: 80 },
    });

    const patches = store.listStatePatches("sess-1");
    expect(patches).toHaveLength(1);
    expect(patches[0].summary).toBe("HP changed");
  });
});

describe("PgServerStore — Trace Events (in-memory)", () => {
  it("should add and list trace events", () => {
    const event = {
      type: "message.completed",
      requestId: "req-1",
      traceId: "trace-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      flowId: "flow-1",
      seq: 0,
      timestamp: new Date().toISOString(),
      payload: { content: "test" },
    };
    store.addTraceEvent("sess-1", event);

    const events = store.listTraceEvents("sess-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message.completed");
  });
});

describe("PgServerStore — Persistence", () => {
  it("should persist worlds to PG", async () => {
    const world = store.createWorld("Persisted World", "Should be in DB");

    // Small delay for fire-and-forget persist
    await new Promise((r) => setTimeout(r, 200));

    const rows = await pgSql`SELECT * FROM sv_worlds WHERE id = ${world.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Persisted World");
  });

  it("should persist sessions to PG", async () => {
    const world = store.createWorld("W", "d");
    const session = store.createSession({ worldId: world.id });

    await new Promise((r) => setTimeout(r, 200));

    const rows = await pgSql`SELECT * FROM sv_sessions WHERE id = ${session.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].world_id).toBe(world.id);
  });

  it("should persist messages to PG", async () => {
    const world = store.createWorld("W", "d");
    const session = store.createSession({ worldId: world.id });
    store.addMessage(session.id, "user", "Persistent message");

    await new Promise((r) => setTimeout(r, 200));

    const rows = await pgSql`SELECT * FROM sv_messages WHERE session_id = ${session.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Persistent message");
  });

  it("should persist characters to PG", async () => {
    const world = store.createWorld("W", "d");
    const session = store.createSession({ worldId: world.id });
    const char = store.createCharacter(session.id, { name: "Persistent Hero" });

    await new Promise((r) => setTimeout(r, 200));

    const rows = await pgSql`SELECT * FROM sv_characters WHERE id = ${char.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Persistent Hero");
  });
});
